interface GmFetchOptions {
  method?: "GET" | "POST" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  responseType?: "text" | "json" | "blob" | "arraybuffer";
  onprogress?: (event: any) => void;
  // ... other GM_xhr options
}

export async function gmFetch<T>(options: GmFetchOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    GM_xmlhttpRequest({
      ...options,
      // default headers/method can be set here
      onload: (response: any) => {
        // Centralised status check
        if (response.status >= 200 && response.status < 300) {
          // response.response automatically handles json/blob/text
          resolve(response.response as T);
        } else {
          // Standardised error
          reject(
            new Error(
              `[GM_API] HTTP Error ${response.status}: ${response.statusText} for ${options.url}`,
            ),
          );
        }
      },
      onerror: (error: any) =>
        reject(
          new Error(
            `[GM_API] Network Error: ${JSON.stringify(error)} for ${options.url}`,
          ),
        ),
      ontimeout: () => reject(new Error(`[GM_API] Timeout for ${options.url}`)),
      onprogress: options.onprogress, // Pass through
    });
  });
}

export async function addSingleVideo(
  tabId: string, // media_id from BiliSelectScript
  tabName: string, // folder name from BiliSelectScript
  bvId: string,
  autoSelectChildren: boolean = false,
): Promise<void> {
  const LOG_PREFIX_ASV = "[AddSingleVideo]";
  try {
    // Step 1: Get video title and page list using GM_xmlhttpRequest

    const viewDataText = await gmFetch<string>({
      method: "GET",
      url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvId}`,
      responseType: "text",
      headers: {
        Referer: "https://www.bilibili.com/", // Adding a referer is good practice
      },
    });

    const viewData = JSON.parse(viewDataText);

    if (viewData.code !== 0 || !viewData.data) {
      console.error(
        `${LOG_PREFIX_ASV} Error fetching view data for ${bvId}:`,
        viewData.message || "No data returned from API",
      );
      return;
    }

    const videoTitle = String(viewData.data.title || "Untitled Video");
    // Check if the video has multiple parts (pages)
    const pages = viewData.data.pages
      ? viewData.data.pages.map((p: any) => ({
        cid: String(p.cid),
        part: String(p.part),
      }))
      : [{ cid: String(viewData.data.cid), part: videoTitle }]; // Fallback for single-part video

    if (pages.length === 0) {
      console.warn(
        `${LOG_PREFIX_ASV} No pages (cid/part) could be resolved for BV ${bvId}.`,
      );
      return;
    }

    if (unsafeWindow.TaskSelectorManager) {
      const parentTaskInput = {
        videoTitle: videoTitle,
        bvId: bvId,
        pages: pages,
      };
      unsafeWindow.TaskSelectorManager.addTaskData(
        tabId,
        tabName,
        [parentTaskInput],
        autoSelectChildren,
      );
    }
  } catch (error) {
    console.error(
      `${LOG_PREFIX_ASV} Failed to process video info for ${bvId}:`,
      error,
    );
  }
}

export function InjectedStyles(styleId: string, cssString: string) {
  document.getElementById(styleId)?.remove();
  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = cssString;
  document.head.appendChild(style);
}