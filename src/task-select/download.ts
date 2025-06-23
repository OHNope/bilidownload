import { SelectedTask } from "./types";
import { states } from "./states";
import { getChunk, saveChunk, deleteChunk } from "./db";
import { updateTaskStateById } from "./utils";

declare var JSZip: {
  new (): JSZipInstance;
};

interface JSZipInstance {
  file(name: string, data: any, options?: any): JSZipInstance;
  generateAsync(
    options: JSZipGeneratorOptions,
    onUpdate?: (metadata: JSZipMetadata) => void,
  ): Promise<Blob>;
}

interface JSZipGeneratorOptions {
  type:
    | "blob"
    | "base64"
    | "binarystring"
    | "uint8array"
    | "arraybuffer"
    | "nodebuffer";
  compression?: "STORE" | "DEFLATE";
  compressionOptions?: {
    level: number;
  };
  // Add other options if needed
}

interface JSZipMetadata {
  percent: number;
  currentFile: string | null;
}

async function runPromisesInPool<T, R>(
  items: T[],
  executor: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  const workers: Promise<void>[] = [];

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) {
        try {
          const result = await executor(item);
          results.push(result);
        } catch (error) {
          console.error("A task in the download pool failed:", error);
          throw error;
        }
      }
    }
  };

  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function gmFetchWithRetry<T>(
  details: any,
  attempts: number,
  initialDelay: number,
  callbacks?: {
    onRetry?: (attempt: number, error: any) => void;
    onProgress?: (event: any) => void;
    onStart?: (handle: { abort: () => void }) => void;
  },
): Promise<T> {
  const onProgress = details.onprogress || callbacks?.onProgress;

  return new Promise<T>((resolve, reject) => {
    const tryRequest = (currentAttempt: number) => {
      const requestHandle = GM_xmlhttpRequest({
        ...details,
        onprogress: onProgress,
        onload: (response: any) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.response as T);
          } else {
            const error = new Error(`HTTP Status ${response.status}`);
            if (currentAttempt < attempts) {
              callbacks?.onRetry?.(currentAttempt + 1, error);
              const delay = initialDelay * Math.pow(2, currentAttempt - 1);
              setTimeout(() => tryRequest(currentAttempt + 1), delay);
            } else {
              reject(error);
            }
          }
        },
        onerror: (error: any) => {
          if (currentAttempt < attempts) {
            callbacks?.onRetry?.(currentAttempt + 1, error);
            const delay = initialDelay * Math.pow(2, currentAttempt - 1);
            setTimeout(() => tryRequest(currentAttempt + 1), delay);
          } else {
            reject(error);
          }
        },
        ontimeout: () => {
          const error = new Error("Request timed out");
          if (currentAttempt < attempts) {
            callbacks?.onRetry?.(currentAttempt + 1, error);
            const delay = initialDelay * Math.pow(2, currentAttempt - 1);
            setTimeout(() => tryRequest(currentAttempt + 1), delay);
          } else {
            reject(error);
          }
        },
        onabort: () => {
          reject(new Error("Request aborted due to network loss."));
        },
      });
      callbacks?.onStart?.(requestHandle);
    };
    tryRequest(1);
  });
}

export async function download(
  tasksToDownload: Record<string, SelectedTask>,
  wid: string,
): Promise<void> {
  const zip = new JSZip();
  let localBlobUrlForCleanup: string | null = null;
  const tasksArray = Object.values(tasksToDownload);

  const processSingleDownload = async (task: SelectedTask): Promise<string> => {
    const taskId = String(task.id);
    const CHUNK_SIZE = 8 * 1024 * 1024;
    const taskAbortController = new AbortController();
    const taskAbortSignal = taskAbortController.signal;
    const abortHandler = () => taskAbortController.abort();
    states.activeDownloads.set(taskId, { abort: abortHandler });
    taskAbortSignal.addEventListener("abort", () =>
      states.activeDownloads.delete(taskId),
    );

    try {
      updateTaskStateById(wid, taskId, {
        status: "downloading",
        progress: 0,
      });
      const videoInfoText = await gmFetchWithRetry<string>(
        {
          method: "GET",
          url: `https://api.bilibili.com/x/player/playurl?bvid=${task.bv}&cid=${task.id}&qn=116&type=&otype=json&platform=html5&high_quality=1`,
          headers: { Referer: `https://www.bilibili.com/video/${task.bv}` },
          responseType: "text",
        },
        states.DOWNLOAD_RETRY_ATTEMPTS,
        states.DOWNLOAD_RETRY_DELAY_MS,
      );
      const jsonResponse = JSON.parse(videoInfoText);
      if (jsonResponse.code !== 0)
        throw new Error(jsonResponse.message || "Failed to get video URL");
      const videoUrl = jsonResponse.data.durl[0].url;
      const totalSize = jsonResponse.data.durl[0].size;
      let partialChunk = await getChunk(taskId);
      let startByte = partialChunk ? partialChunk.size : 0;

      if (!(partialChunk && startByte === totalSize)) {
        while (startByte < totalSize) {
          if (taskAbortSignal.aborted)
            throw new Error("Download aborted by user.");
          const endByte = Math.min(startByte + CHUNK_SIZE - 1, totalSize - 1);
          const newChunkBlob = await new Promise<Blob>((resolve, reject) => {
            const requestHandle = GM_xmlhttpRequest({
              method: "GET",
              url: videoUrl,
              responseType: "blob",
              headers: {
                Referer: "https://www.bilibili.com/",
                Range: `bytes=${startByte}-${endByte}`,
              },
              timeout: 120000,
              onload: (response: any) =>
                response.status === 206 || response.status === 200
                  ? resolve(response.response as Blob)
                  : reject(
                      new Error(`HTTP Error ${response.status} for chunk`),
                    ),
              onerror: (_err: any) =>
                reject(new Error("Network Error for chunk")),
              ontimeout: () => reject(new Error("Chunk download timed out")),
              onabort: () => reject(new Error("Chunk download aborted.")),
            });
            taskAbortSignal.addEventListener("abort", () =>
              requestHandle.abort(),
            );
          });
          const combinedBlob = partialChunk
            ? new Blob([partialChunk, newChunkBlob])
            : newChunkBlob;
          await saveChunk(taskId, combinedBlob);
          partialChunk = combinedBlob;
          startByte = partialChunk.size;
          updateTaskStateById(wid, taskId, {
            status: "downloading",
            progress: Math.round((startByte / totalSize) * 100),
          });
        }
      }
      if (partialChunk && partialChunk.size >= totalSize) {
        zip.file(task.name + ".mp4", partialChunk);
        updateTaskStateById(wid, taskId, {
          status: "completed",
          progress: 100,
        });
        await deleteChunk(taskId);
        return `成功: ${task.name}`;
      } else {
        throw new Error("Download loop finished but file is incomplete.");
      }
    } catch (err: any) {
      updateTaskStateById(wid, taskId, { status: "failed", progress: 0 });
      throw err;
    } finally {
      states.activeDownloads.delete(taskId);
    }
  };

  try {
    await runPromisesInPool(
      tasksArray,
      processSingleDownload,
      states.MAX_CONCURRENT_DOWNLOADS,
    );
    const zipBlob = await zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 1 },
      },
      (_metadata) => {},
    );
    localBlobUrlForCleanup = window.URL.createObjectURL(zipBlob);
    const newWindow = window.open("", "_blank");
    if (newWindow) {
      try {
        const newDoc = newWindow.document;
        newDoc.title = "Download File";
        const style = newDoc.createElement("style");
        style.textContent = `body { display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; font-family: sans-serif; background-color: #f8f9fa; } a { font-size: 1.5em; padding: 15px 30px; border: 1px solid #ccc; text-decoration: none; color: #007bff; background-color: #fff; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); transition: all 0.2s ease-in-out; } a:hover { background-color: #f0f0f0; transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0,0,0,0.15); }`;
        newDoc.head.appendChild(style);
        const link = newDoc.createElement("a");
        link.href = localBlobUrlForCleanup;
        link.textContent = "Download Generated ZIP";
        link.download = "downloaded_mp4s.zip";
        newDoc.body.appendChild(link);
        newWindow.focus();
        setTimeout(() => {
          if (localBlobUrlForCleanup)
            URL.revokeObjectURL(localBlobUrlForCleanup);
        }, 480 * 1000);
      } catch (err) {
        newWindow.close();
        if (localBlobUrlForCleanup) URL.revokeObjectURL(localBlobUrlForCleanup);
      }
    } else {
      alert(
        "无法打开新窗口。请检查您的浏览器设置，确保允许来自此站点的弹出窗口。",
      );
      if (localBlobUrlForCleanup) URL.revokeObjectURL(localBlobUrlForCleanup);
    }
  } catch (error) {
    alert("下载池中的一个任务失败，整个过程已停止。请检查控制台获取详细信息。");
    if (localBlobUrlForCleanup) URL.revokeObjectURL(localBlobUrlForCleanup);
  }
}
