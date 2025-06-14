// ==UserScript==
// @name         BiliBiliDownload(TS)
// @version      0.1
// @description  BILIBILI DOWNLOAD
// @author       OHNope
// @match        https://www.bilibili.com/video*
// @match        https://www.bilibili.com/*bvid*
// @match        https://space.bilibili.com/*
// @require      https://cdn.staticfile.org/jszip/3.5.0/jszip.min.js
// @grant        GM_xmlhttpRequest
// @connect      api.bilibili.com
// @connect      bilibili.com
// @connect      bilivideo.com
// @connect      hdslb.com
// @connect      akamaized.net
// @grant unsafeWindow
// ==/UserScript==

// --- TypeScript Type Definitions ---
interface GmXhrHandle {
  abort: () => void;
}

// REPLACE THE OLD DECLARATION WITH THIS CORRECTED ONE
declare const GM_xmlhttpRequest: (details: any) => GmXhrHandle;
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
interface BasicTask {
  name: string; // part name
  bv: string; // bvId of the parent video
}
// In TaskSelectScript
interface Task extends BasicTask {
  // Represents a Sub-Task (分P)
  id: string; // cid
}

interface ParentTask extends BasicTask {
  children: Task[];
  isExpanded: boolean; // UI state for collapsing
  MediaId: string;
}

interface TabData {
  name: string;
  tasks: ParentTask[]; // NEW: List of parent tasks
}

interface SelectedTask extends Task {
  marked: boolean;
}

interface TabState {
  taskScrollTop: number;
  tabScrollLeft: number;
  needsRender: boolean;
  lastRenderedScrollTop: number;
}

interface WindowUiState {
  collapsed: boolean;
  top: string;
  left: string;
  width: string;
  height: string;
}

// MODIFIED
type TaskDownloadStatus =
  | "pending"
  | "downloading"
  | "retrying"
  | "completed"
  | "failed"
  | "restarted";

interface ProgressTaskItem extends SelectedTask {
  progress: number;
  windowId: string;
  status: TaskDownloadStatus; // 新增字段
}

interface ProgressWindowState {
  id: string;
  top: string;
  left: string;
  width: string;
  height: string;
  scrollTop: number;
  needsRender: boolean;
  lastRenderedScrollTop: number;
}

interface ProgressWindowData {
  element: HTMLDivElement;
  listElement: HTMLDivElement;
  closeButton: HTMLDivElement;
  tasks: ProgressTaskItem[];
  state: ProgressWindowState;
  checkCompletion: () => void;
  updateProgress: (taskId: string, progress: number) => void;
  renderItems: (force?: boolean) => void;
  handleScroll: () => void;
  cleanupFunctions: (() => void)[];
}
// Extend Window interface for global properties
// --- TypeScript Type Definitions ---

interface TaskSelectorManagerAPI {
  addTaskData: (
    tabId: string,
    tabName: string,
    // This now represents parent video info.
    // The 'id' here could be the BV, and 'name' the video title.
    // The actual sub-tasks (分P) will be fetched or passed differently.
    // For simplicity, let's assume `addSingleVideo` prepares this structure.
    parentTaskInfos: {
      videoTitle: string;
      bvId: string;
      pages: { cid: string; part: string }[];
    }[],
    autoSelectNewTasks?: boolean,
  ) => void;
  updateTaskProgress: (
    windowId: string,
    taskId: string,
    progress: number,
  ) => void; // taskId is cid
  getSelectedTaskIds: () => string[]; // Returns selected CIDs
  destroy: () => void;
  selectTasksByBv: (
    bvId: string,
    select: boolean,
    originatingFromBiliSelect?: boolean,
  ) => void;
  isTaskSelected: (taskId: string) => boolean; // taskId is cid
  isAnyTaskSelectedForBv: (bvId: string) => boolean;
}

interface BiliSelectScriptAPI_Interface {
  selectVideoCardByBv: (
    bvId: string,
    select: boolean,
    originatingFromTaskManager?: boolean,
    originMediaId?: string | null,
  ) => void;
  isBvSelected: (bvId: string) => boolean;
}

interface CustomWindow extends Window {
  TaskSelectorManager?: TaskSelectorManagerAPI;
  BiliSelectScriptAPI?: BiliSelectScriptAPI_Interface; // 新增
  folders?: Map<string, string>;
  BiliSelectScript?: (initialMediaId: string, window: CustomWindow) => void;
  TaskSelectScript?: (window: CustomWindow) => void;
  showBiliSelections?: (mediaId?: string | null) => void;
  removeBiliSelections?: (mediaId: string, bvIdsToRemove: string[]) => void;
  unsafeWindow?: CustomWindow;
  URL: typeof URL;
}
interface GmFetchOptions {
  method?: "GET" | "POST" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  responseType?: "text" | "json" | "blob" | "arraybuffer";
  onprogress?: (event: any) => void;
  // ... other GM_xhr options
}

async function gmFetch<T>(options: GmFetchOptions): Promise<T> {
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

declare const unsafeWindow: CustomWindow;

function TaskSelectScript(window: CustomWindow): void {
  // --- 防止重复注入 ---
  if (window.TaskSelectorManager) {
    console.log(
      "Task Selector Manager already injected. Destroying previous instance.",
    );
    window.TaskSelectorManager.destroy?.();
  }

  // --- 配置常量 ---
  const MAX_CONCURRENT_DOWNLOADS = 10; // <-- ADD THIS. (4 is a safe number)
  const TASK_ITEM_HEIGHT = 35;
  const DOWNLOAD_RETRY_ATTEMPTS = 3; // <-- ADD THIS: How many times to retry a failed download
  const DOWNLOAD_RETRY_DELAY_MS = 2000; // <-- ADD THIS: Initial delay before the first retry
  const PROGRESS_ITEM_HEIGHT = 40;
  const PROGRESS_VISIBLE_ITEMS_BUFFER = 10;
  const SCROLL_RENDER_THRESHOLD = TASK_ITEM_HEIGHT / 2;
  // 新增常量 for hierarchical display
  const PARENT_TASK_ITEM_HEIGHT = 38; // Example height for parent tasks
  const CHILD_TASK_ITEM_HEIGHT = 32; // Example height for

  // --- 核心状态管理 ---
  let allTasksData: Record<string, TabData> = {};
  let activeDownloads = new Map<string, { abort: () => void }>();

  let currentTabId: string | null = null;
  let tabStates: Record<string, TabState> = {};
  let windowState: WindowUiState = {
    collapsed: true,
    top: "20px",
    left: "20px",
    width: "350px",
    height: "450px",
  };

  // NEW: A Set to hold the IDs of actively selected (but not yet confirmed) tasks.
  let selectedTaskIds = new Set<string>();

  // NEW: A Set to hold the IDs of tasks that have been confirmed for download.
  // This drives the "marked" visual style.
  let markedTaskIds = new Set<string>();
  let taskMap = new Map<string, Task>();
  // NEW: An array to hold all cleanup functions for listeners.
  const globalCleanupFunctions: (() => void)[] = [];

  // ... other state variables
  let isResizing = false;
  void isResizing;
  let resizeHandle: HTMLElement | null = null;
  void resizeHandle;
  let isSelectingBox = false;
  let selectionBoxStart = { x: 0, y: 0 };
  let selectionBoxElement: HTMLDivElement | null = null;
  let initialSelectedInTabForBoxOp = new Set<string>();
  let progressWindows: Record<string, ProgressWindowData> = {};
  let progressWindowCounter = 0;

  let tickScheduled = false;

  // --- DOM 元素引用 ---
  let container: HTMLDivElement | null = null;
  let header: HTMLDivElement | null = null;
  let body: HTMLDivElement | null = null;
  let taskListContainer: HTMLDivElement | null = null;
  let tabsContainer: HTMLDivElement | null = null;
  let buttonsContainer: HTMLDivElement | null = null;
  let collapseIndicator: HTMLSpanElement | null = null;

  // --- 工具函数 ---
  function debounce<T extends (...args: any[]) => void>(
    func: T,
    wait: number,
  ): (...args: Parameters<T>) => void {
    let timeout: number | undefined;
    return (...args: Parameters<T>) => {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = window.setTimeout(later, wait);
    };
  }
  // --- 工具函数 --- (Add these new functions here)

  /**
   * Creates a generic drag handler for an element.
   * @param options - Configuration for the drag behavior.
   * @returns A destroy function to remove the event listener.
   */
  function createDragHandler(options: {
    triggerElement: HTMLElement;
    movableElement: HTMLElement;
    state: { top: string; left: string }; // Object to store final position
    onDragStart?: () => void;
    onDragEnd?: () => void;
  }): () => void {
    const { triggerElement, movableElement, state, onDragStart, onDragEnd } =
      options;
    let dragOffset = { x: 0, y: 0 };
    let isDragging = false;

    const handleMouseMove = (event: MouseEvent) => {
      if (!isDragging) return;
      event.preventDefault();
      let newTop = event.clientY - dragOffset.y;
      let newLeft = event.clientX - dragOffset.x;

      newTop = Math.max(
        0,
        Math.min(newTop, window.innerHeight - movableElement.offsetHeight),
      );
      newLeft = Math.max(
        0,
        Math.min(newLeft, window.innerWidth - movableElement.offsetWidth),
      );

      movableElement.style.top = `${newTop}px`;
      movableElement.style.left = `${newLeft}px`;
    };

    const handleMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;

      // Persist the final position
      state.top = movableElement.style.top;
      state.left = movableElement.style.left;

      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);

      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      triggerElement.style.cursor = "grab";

      onDragEnd?.();
    };

    const handleMouseDown = (event: MouseEvent) => {
      // Ensure we don't trigger on buttons, etc. inside the header
      if (
        (event.target as HTMLElement).closest(
          "button, .task-selector-collapse-indicator, .task-progress-close-btn, .task-progress-resizer",
        )
      ) {
        return;
      }
      isDragging = true;
      const rect = movableElement.getBoundingClientRect();
      dragOffset = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };

      document.addEventListener("mousemove", handleMouseMove, {
        passive: false,
      });
      document.addEventListener("mouseup", handleMouseUp);

      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      triggerElement.style.cursor = "grabbing";

      onDragStart?.();
    };

    triggerElement.addEventListener("mousedown", handleMouseDown);

    // Return a cleanup function
    return () => {
      triggerElement.removeEventListener("mousedown", handleMouseDown);
    };
  }

  /**
   * Creates a generic resize handler for an element.
   * @param options - Configuration for the resize behavior.
   * @returns A destroy function to remove the event listener.
   */
  function createResizeHandler(options: {
    resizeHandleElement: HTMLElement;
    resizableElement: HTMLElement;
    state: { width: string; height: string };
    onResize?: () => void;
    onResizeEnd?: () => void;
  }): () => void {
    const {
      resizeHandleElement,
      resizableElement,
      state,
      onResize,
      onResizeEnd,
    } = options;
    let startPos = { x: 0, y: 0, width: 0, height: 0 };
    let isResizing = false;

    const handleMouseMove = (event: MouseEvent) => {
      if (!isResizing) return;
      event.preventDefault();
      const dx = event.clientX - startPos.x;
      const dy = event.clientY - startPos.y;

      const style = getComputedStyle(resizableElement);
      const minW = parseInt(style.minWidth) || 100;
      const minH = parseInt(style.minHeight) || 70;

      let newWidth = Math.max(minW, startPos.width + dx);
      let newHeight = Math.max(minH, startPos.height + dy);

      resizableElement.style.width = `${newWidth}px`;
      resizableElement.style.height = `${newHeight}px`;
      onResize?.();
    };

    const handleMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;

      // Persist the final size
      state.width = resizableElement.style.width;
      state.height = resizableElement.style.height;

      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);

      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      onResizeEnd?.();
    };

    const handleMouseDown = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      isResizing = true;

      startPos = {
        x: event.clientX,
        y: event.clientY,
        width: resizableElement.offsetWidth,
        height: resizableElement.offsetHeight,
      };

      document.addEventListener("mousemove", handleMouseMove, {
        passive: false,
      });
      document.addEventListener("mouseup", handleMouseUp);

      document.body.style.userSelect = "none";
      document.body.style.cursor = "nwse-resize";
    };

    resizeHandleElement.addEventListener("mousedown", handleMouseDown);

    return () => {
      resizeHandleElement.removeEventListener("mousedown", handleMouseDown);
    };
  }
  /**
   * Executes an array of promise-returning tasks with a concurrency limit.
   * @param items An array of items to process.
   * @param executor An async function that takes one item and returns a Promise.
   * @param concurrency The maximum number of tasks to run at the same time.
   * @returns A Promise that resolves with an array of all results when all tasks are complete.
   */
  async function runPromisesInPool<T, R>(
    items: T[],
    executor: (item: T) => Promise<R>,
    concurrency: number,
  ): Promise<R[]> {
    const results: R[] = [];
    const queue = [...items]; // Create a mutable copy of items to act as the queue.
    const workers: Promise<void>[] = [];

    const worker = async () => {
      while (queue.length > 0) {
        const item = queue.shift(); // Get the next item from the queue
        if (item) {
          try {
            // Await the executor and push the result.
            // Note: The order of results will not match the original items array.
            // If order is needed, a more complex implementation is required.
            const result = await executor(item);
            results.push(result);
          } catch (error) {
            // If one task fails, we want the whole process to stop and report the error.
            // The Promise.all below will catch this re-thrown error.
            console.error("A task in the download pool failed:", error);
            throw error;
          }
        }
      }
    };

    // Start the workers
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }

    // Wait for all worker promises to complete.
    // A worker completes when the queue is empty.
    await Promise.all(workers);

    return results;
  }
  /**
   * Wraps a GM_xmlhttpRequest promise in a retry loop with exponential backoff.
   * @param details The GM_xmlhttpRequest details object.
   * @param attempts The total number of attempts to make.
   * @param initialDelay The initial delay in milliseconds before the first retry.
   * @returns A promise that resolves with the successful response.
   */
  // 在 --- 工具函数 --- 部分
  function gmFetchWithRetry<T>(
    details: any,
    attempts: number,
    initialDelay: number,
    // 新增的回调参数
    callbacks?: {
      onRetry?: (attempt: number, error: any) => void;
      onProgress?: (event: any) => void;
      onStart?: (handle: { abort: () => void }) => void;
    },
  ): Promise<T> {
    // 从 details 中提取 onprogress 并传递给 callbacks，保持原 onprogress 逻辑
    const onProgress = details.onprogress || callbacks?.onProgress;

    return new Promise<T>((resolve, reject) => {
      const tryRequest = (currentAttempt: number) => {
        const requestHandle = GM_xmlhttpRequest({
          ...details,
          onprogress: onProgress, // 使用统一的 onprogress
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
              // *** 调用 onRetry 回调 ***
              callbacks?.onRetry?.(currentAttempt + 1, error);
              const delay = initialDelay * Math.pow(2, currentAttempt - 1);
              setTimeout(() => tryRequest(currentAttempt + 1), delay);
            } else {
              reject(error);
            }
          },
          onabort: () => {
            // When we manually abort, reject the promise immediately.
            reject(new Error("Request aborted due to network loss."));
          },
        });
        // Pass the handle out via the onStart callback
        callbacks?.onStart?.(requestHandle);
      };
      tryRequest(1);
    });
  }
  // --- CSS 样式 ---
  const styles: string = `
      .task-selector-container { position: fixed; z-index: 99999; background-color: rgba(240, 240, 240, 0.95); border: 1px solid #ccc; box-shadow: 0 4px 12px rgba(0,0,0,0.2); display: flex; flex-direction: column; transition: border-radius 0.2s ease-out; overflow: hidden; user-select: none; color: #333; font-family: sans-serif; min-width: 120px; min-height: 70px; }
      .task-selector-container.collapsed { width: 50px !important; height: 50px !important; border-radius: 50%; cursor: grab; overflow: hidden; align-items: center; justify-content: center; min-width: 50px !important; min-height: 50px !important; }
      .task-selector-container.collapsed > *:not(.task-selector-collapse-indicator):not(.task-selector-header) { display: none; }
      .task-selector-container.collapsed .task-selector-header { border-bottom: none; background: transparent; cursor: default; }
      .task-selector-container.collapsed .task-selector-header-title { display: none; }
      .task-selector-header { padding: 5px 8px; background-color: #e0e0e0; cursor: grab; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; border-bottom: 1px solid #ccc; min-height: 26px; }
      .task-selector-header:active { cursor: grabbing; }
      .task-selector-header-title { font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 10px; }
      .task-selector-collapse-indicator { width: 16px; height: 16px; cursor: pointer; text-align: center; line-height: 16px; border: 1px solid #999; border-radius: 3px; background-color: #f8f8f8; flex-shrink: 0; z-index: 5; }
      .task-selector-container.collapsed .task-selector-collapse-indicator { border: none; font-size: 20px; background-color: transparent; }
      .task-selector-body { display: flex; flex-grow: 1; overflow: hidden; min-height: 40px; }
      .task-selector-buttons { display: flex; flex-direction: column; padding: 10px 5px; border-right: 1px solid #ccc; background-color: #e8e8e8; flex-shrink: 0; }
      .task-selector-buttons button { margin-bottom: 8px; padding: 6px 8px; font-size: 12px; cursor: pointer; background-color: #f0f0f0; border: 1px solid #bbb; border-radius: 3px; white-space: nowrap; transition: background-color 0.15s ease; }
      .task-selector-buttons button:hover { background-color: #d5d5d5; } .task-selector-buttons button:active { background-color: #ccc; }
      .task-selector-content-wrapper { flex-grow: 1; display: flex; flex-direction: column; overflow: hidden; }


      .task-selector-task-list-container {
          flex-grow: 1;
          overflow-y: auto;
          overflow-x: hidden;
          /* MODIFICATION: Add position relative */
          position: relative;
          -ms-overflow-style: none;
          scrollbar-width: thin; /* It's better to see the scrollbar for virtual scroll */
      }
      /* Optional: Style the scrollbar if not hiding it */
      .task-selector-task-list-container::-webkit-scrollbar {
          width: 8px;
      }
      .task-selector-task-list-container::-webkit-scrollbar-thumb {
          background-color: #c1c1c1;
          border-radius: 4px;
      }

      /* MODIFICATION: Task items are now positioned absolutely */
      .task-selector-task-item {
          padding: 5px 8px;
          margin: 0; /* Margin is no longer needed */
          background-color: #fff;
          border: 1px solid #ddd;
          border-radius: 3px;
          cursor: pointer;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          display: flex;
          align-items: center;
          transition: background-color 0.1s ease, border-color 0.1s ease;

          /* --- NEW VIRTUALIZATION STYLES --- */
          position: absolute;
          top: 0;
          left: 5px; /* Corresponds to container padding */
          right: 5px; /* Corresponds to container padding */
          box-sizing: border-box; /* Crucial for correct height/width */
          /* Height is now set via JS, but we can keep the base calc for consistency */
          height: ${TASK_ITEM_HEIGHT - 12}px;
      }

      /* NEW: Spacer element style */
      .virtual-scroll-spacer {
          position: absolute;
          top: 0;
          left: 0;
          width: 1px;
          height: 0; /* Height will be set by JS */
          z-index: -1; /* Keep it out of the way */
      }

      .task-selector-task-item.selected { background-color: #d0eaff; border-color: #a0caff; font-weight: bold; }
      .task-selector-task-item.marked { background-color: #e0ffe0 !important; border-color: #a0cca0 !important; opacity: 0.7; }
      .task-selector-tabs-container { border-top: 1px solid #ccc; padding: 5px 5px 0 5px; background-color: #e0e0e0; overflow-x: auto; white-space: nowrap; flex-shrink: 0; scrollbar-width: none; -ms-overflow-style: none; }
      .task-selector-tabs-container::-webkit-scrollbar { display: none; }
      .task-selector-tab-item { display: inline-flex; align-items: center; min-height: 25px; padding: 5px 12px; margin-right: 5px; cursor: pointer; border: 1px solid #ccc; border-bottom: none; border-radius: 4px 4px 0 0; background-color: #f0f0f0; font-size: 13px; transition: background-color 0.15s ease; position: relative; bottom: -1px; }
      .task-selector-tab-item:hover { background-color: #e5e5e5; }
      .task-selector-tab-item.active { background-color: rgba(240, 240, 240, 0.95); font-weight: bold; border-color: #ccc; border-bottom: 1px solid rgba(240, 240, 240, 0.95); }
      .task-selection-box { position: absolute; border: 1px dashed #007bff; background-color: rgba(0, 123, 255, 0.1); z-index: 10000; pointer-events: none; }
      .task-selector-resizer { position: absolute; width: 12px; height: 12px; right: 0; bottom: 0; cursor: nwse-resize; z-index: 10; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; }
      .task-selector-container.collapsed .task-selector-resizer { display: none; }
      .task-progress-window { position: fixed; z-index: 9998; background-color: rgba(255, 255, 255, 0.98); border: 1px solid #bbb; box-shadow: 0 3px 9px rgba(0,0,0,0.15); display: flex; flex-direction: column; overflow: hidden; user-select: none; color: #333; font-family: sans-serif; min-width: 200px; min-height: 100px; }
      .task-progress-header { padding: 5px 8px; background-color: #f0f0f0; cursor: grab; border-bottom: 1px solid #ccc; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; min-height: 26px; }
      .task-progress-header:active { cursor: grabbing; }
      .task-progress-title { font-weight: bold; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 10px; }
      .task-progress-close-btn { background: #ffcccc; border: 1px solid #ffaaaa; color: #a00; border-radius: 50%; width: 18px; height: 18px; line-height: 16px; text-align: center; cursor: pointer; font-weight: bold; display: none; font-size: 12px; flex-shrink: 0; }
      .task-progress-close-btn.visible { display: block; }
      .task-progress-list-container { flex-grow: 1; overflow-y: auto; padding: 0 8px; scrollbar-width: none; -ms-overflow-style: none; }
      .task-progress-list-container::-webkit-scrollbar { display: none; }
      .task-progress-item { margin: 0 0 8px 0; padding: 5px; border: 1px solid #eee; border-radius: 3px; background-color: #f9f9f9; display: flex; flex-direction: column; min-height: ${
        PROGRESS_ITEM_HEIGHT - 18
      }px; height: auto; }
      .task-progress-item-name { font-size: 12px; margin-bottom: 4px; white-space: normal; word-break: break-word; }
      .task-progress-bar-container { height: 10px; background-color: #e0e0e0; border-radius: 5px; overflow: hidden; border: 1px solid #d0d0d0; flex-shrink: 0; margin-top: auto; }

      .task-progress-bar {
        height: 100%;
        width: 0%;
        background-color: #76c7c0; /* Default/Downloading color */
        border-radius: 5px 0 0 5px;
        transition: width 0.3s ease-out, background-color 0.3s ease-in-out; /* 添加 background-color 过渡 */
      }
      .task-progress-bar.status-retrying {
              background-color: #f0ad4e; /* Orange for retrying */
            }

            /* ADD THIS NEW STYLE */
            .task-progress-bar.status-restarted {
              background-color: #5bc0de; /* Info blue */
            }

            .task-progress-bar.status-failed {
              background-color: #d9534f; /* Red for failure */
              width: 100% !important; /* 失败时也填满，但用红色表示 */
            }

      /* (可选) 在任务项名称旁边添加状态文本 */
      .task-progress-item-status-text {
        font-size: 10px;
        color: #888;
        margin-left: 8px;
        font-style: italic;
      }

      .task-progress-resizer { position: absolute; width: 12px; height: 12px; right: 0; bottom: 0; cursor: nwse-resize; z-index: 10; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; }
      .task-selector-parent-task {
    font-weight: bold;
    /* background-color: #f0f0f0; slightly different bg for parent */
    display: flex; /* For expander and title alignment */
    align-items: center;
}
.task-selector-child-task {
    /* margin-left: 20px; /* Indentation handled in createChildTaskNode for now */
    /* background-color: #fff; */
}
.task-expander {
    display: inline-block;
    width: 1em; /* Ensure space for icon */
    user-select: none;
}

/* Adjust padding if using fixed heights and box-sizing: border-box */
.task-selector-task-item {
    /* ... existing ... */
    padding: 5px 8px; /* Keep consistent padding */
    box-sizing: border-box;
}
  `;

  // --- DOM Manipulation Functions ---
  function injectStyles(): void {
    document.getElementById("task-selector-styles")?.remove();
    const s = document.createElement("style");
    s.id = "task-selector-styles";
    s.innerText = styles;
    document.head.appendChild(s);
  }

  function createTabItemNode(tabId: string, tabData: TabData): HTMLDivElement {
    const i = document.createElement("div");
    i.className = "task-selector-tab-item";
    i.textContent = tabData.name;
    i.dataset.tabId = tabId;
    if (tabId === currentTabId) i.classList.add("active");
    i.addEventListener("click", handleTabClick as EventListener);
    i.setAttribute("draggable", "false");
    return i;
  }
  // In TaskSelectScript
  /**
   * Toggles the expansion state of a parent task and schedules a re-render.
   * @param parentTask The parent task object to toggle.
   */
  function toggleParentTaskExpansion(parentTask: ParentTask): void {
    parentTask.isExpanded = !parentTask.isExpanded;
    if (currentTabId && tabStates[currentTabId]) {
      tabStates[currentTabId].needsRender = true;
      tabStates[currentTabId].lastRenderedScrollTop = -1; // Force a full re-render
      scheduleTick();
    }
  }
  function createParentTaskNode(parentTask: ParentTask): HTMLDivElement {
    const pItem = document.createElement("div");
    pItem.className = "task-selector-task-item task-selector-parent-task";
    pItem.dataset.bvId = parentTask.bv;

    pItem.style.height = `${PARENT_TASK_ITEM_HEIGHT}px`;

    // --- Expander Icon ---
    const expander = document.createElement("span");
    expander.className = "task-expander";
    expander.textContent = parentTask.isExpanded ? "▼ " : "▶ ";
    expander.style.marginRight = "5px";
    expander.style.cursor = "pointer";
    expander.addEventListener("click", (event) => {
      event.stopPropagation(); // Prevent other listeners if any
      toggleParentTaskExpansion(parentTask);
    });

    // --- Title Span ---
    const titleSpan = document.createElement("span");
    titleSpan.textContent = parentTask.name;
    titleSpan.title = parentTask.name;
    titleSpan.style.flexGrow = "1"; // Allow title to take up space
    titleSpan.style.cursor = "pointer";

    // Add the same simple click handler to the title
    titleSpan.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleParentTaskExpansion(parentTask);
    });

    pItem.setAttribute("draggable", "false");
    pItem.appendChild(expander);
    pItem.appendChild(titleSpan);
    pItem.setAttribute("draggable", "false");

    return pItem; // Return the element directly
  }

  function createChildTaskNode(
    task: Task,
    parentBvId: string,
    MediaId: string,
  ): HTMLDivElement {
    const i = document.createElement("div");
    i.className = "task-selector-task-item task-selector-child-task";
    i.textContent = task.name;
    i.title = task.name;
    i.dataset.taskId = task.id; // cid
    i.dataset.MediaId = MediaId;
    i.dataset.bv = parentBvId; // Store parent BV for easier access
    i.style.height = `${CHILD_TASK_ITEM_HEIGHT}px`; // Set fixed height
    i.style.marginLeft = "20px"; // Indent child tasks

    // NEW conditions
    if (markedTaskIds.has(task.id)) {
      i.classList.add("marked");
    } else if (selectedTaskIds.has(task.id)) {
      i.classList.add("selected");
    }

    i.addEventListener("click", handleChildTaskClick as EventListener); // New handler
    i.setAttribute("draggable", "false");
    return i;
  }

  function renderTabs(): void {
    if (!tabsContainer) return;
    tabsContainer.innerHTML = "";
    const tIds = Object.keys(allTasksData);
    if (tIds.length === 0) return;
    tIds.forEach((tid) =>
      tabsContainer!.appendChild(createTabItemNode(tid, allTasksData[tid])),
    );
    if (currentTabId && tabStates[currentTabId]?.tabScrollLeft)
      tabsContainer.scrollLeft = tabStates[currentTabId].tabScrollLeft;
    else tabsContainer.scrollLeft = 0;

    if (!currentTabId && tIds.length > 0) currentTabId = tIds[0];
    if (currentTabId && !allTasksData[currentTabId] && tIds.length > 0)
      currentTabId = tIds[0];

    const aTab = currentTabId
      ? tabsContainer.querySelector<HTMLDivElement>(
          `.task-selector-tab-item[data-tab-id="${currentTabId}"]`,
        )
      : null;
    if (aTab) aTab.classList.add("active");
    else if (tabsContainer.firstChild) {
      (tabsContainer.firstChild as HTMLElement).classList.add("active");
      currentTabId = (tabsContainer.firstChild as HTMLElement).dataset.tabId!;
    }
  }

  // Define the structure for our flattened list
  interface FlatTaskItem {
    type: "parent" | "child";
    data: ParentTask | Task;
    parent?: ParentTask; // For child tasks
    top: number;
    height: number;
  }

  function renderTasksForCurrentTab(forceUpdate: boolean = false): void {
    const state = currentTabId ? tabStates[currentTabId] : null;
    if (
      !currentTabId ||
      !allTasksData[currentTabId] ||
      !taskListContainer ||
      !state
    ) {
      if (taskListContainer) {
        // Clear everything except the spacer
        const spacer = taskListContainer.querySelector(
          ".virtual-scroll-spacer",
        );
        taskListContainer.innerHTML = "";
        if (spacer) taskListContainer.appendChild(spacer);
      }
      if (state) state.lastRenderedScrollTop = -1;
      return;
    }

    const scrollTop = taskListContainer.scrollTop;
    const containerHeight = taskListContainer.clientHeight;
    state.taskScrollTop = scrollTop;

    if (containerHeight <= 0 && !forceUpdate) return;

    // --- 1. Flatten Data and Calculate Positions ---
    const flatItems: FlatTaskItem[] = [];
    let currentY = 5; // Start with top padding of 5px
    allTasksData[currentTabId].tasks.forEach((parentTask) => {
      flatItems.push({
        type: "parent",
        data: parentTask,
        top: currentY,
        height: PARENT_TASK_ITEM_HEIGHT,
      });
      currentY += PARENT_TASK_ITEM_HEIGHT;
      if (parentTask.isExpanded) {
        parentTask.children.forEach((childTask) => {
          flatItems.push({
            type: "child",
            data: childTask,
            parent: parentTask,
            top: currentY,
            height: CHILD_TASK_ITEM_HEIGHT,
          });
          currentY += CHILD_TASK_ITEM_HEIGHT;
        });
      }
    });
    const totalHeight = currentY + 5; // Add bottom padding

    // --- 2. Update the Spacer Height ---
    const spacer = taskListContainer.querySelector(
      ".virtual-scroll-spacer",
    ) as HTMLDivElement;
    if (spacer) {
      spacer.style.height = `${totalHeight}px`;
    }

    // --- 3. Determine the Visible Range ---
    const buffer = 10; // Render 10 items above and below the viewport
    let startIndex = flatItems.findIndex(
      (item) => item.top + item.height > scrollTop,
    );
    let endIndex = flatItems.findIndex(
      (item) => item.top > scrollTop + containerHeight,
    );

    // Adjust for edge cases and buffer
    startIndex = Math.max(0, startIndex - buffer);
    if (endIndex === -1) {
      // Scrolled to the bottom
      endIndex = flatItems.length;
    } else {
      endIndex = Math.min(flatItems.length, endIndex + buffer);
    }

    // --- 4. Render Only the Visible Slice ---
    const fragment = document.createDocumentFragment();
    const itemsToRender = flatItems.slice(startIndex, endIndex);

    itemsToRender.forEach((item) => {
      let node: HTMLDivElement;
      if (item.type === "parent") {
        node = createParentTaskNode(item.data as ParentTask);
      } else {
        // The child node needs its parent's info
        const childData = item.data as Task;
        const parentData = item.parent!; // We know it exists for child items
        node = createChildTaskNode(
          childData,
          parentData.bv,
          parentData.MediaId,
        );
      }

      // Position the node absolutely using transform for performance
      node.style.transform = `translateY(${item.top}px)`;
      fragment.appendChild(node);
    });

    // --- 5. Efficiently Update the DOM ---
    // Remove all previous task items, but leave the spacer untouched
    while (taskListContainer.childElementCount > 1) {
      taskListContainer.lastChild!.remove();
    }
    taskListContainer.appendChild(fragment);

    state.lastRenderedScrollTop = scrollTop;
    state.needsRender = false;

    // This part of your logic for forcing a scroll position remains valid
    if (forceUpdate) {
      const forcedScrollTop = state.taskScrollTop ?? 0;
      requestAnimationFrame(() => {
        if (taskListContainer) taskListContainer.scrollTop = forcedScrollTop;
      });
    }
  }
  // --- Scroll / Tick Functions ---
  function scheduleTick(): void {
    if (!tickScheduled) {
      tickScheduled = true;
      requestAnimationFrame(tick);
    }
  }

  function tick(): void {
    tickScheduled = false;
    if (
      taskListContainer &&
      !windowState.collapsed &&
      currentTabId &&
      tabStates[currentTabId]?.needsRender
    ) {
      const state = tabStates[currentTabId];
      if (
        state.lastRenderedScrollTop === -1 ||
        Math.abs(state.taskScrollTop - state.lastRenderedScrollTop) >
          SCROLL_RENDER_THRESHOLD
      ) {
        renderTasksForCurrentTab();
      } else {
        state.needsRender = false;
      }
    }

    for (const windowId in progressWindows) {
      const pwData = progressWindows[windowId];
      const pwState = pwData?.state;
      if (pwData?.listElement && pwState?.needsRender) {
        if (
          pwState.lastRenderedScrollTop === -1 ||
          Math.abs(pwState.scrollTop - pwState.lastRenderedScrollTop) >
            SCROLL_RENDER_THRESHOLD // Using main scroll threshold, can be different
        ) {
          renderProgressItems(windowId);
        } else {
          pwState.needsRender = false;
        }
      }
    }
  }

  // --- Event Handlers ---
  /**
   * Handles the browser's 'offline' event.
   */
  function handleConnectionLost(): void {
    console.warn("[Network] Connection lost. Aborting all active downloads...");
    if (activeDownloads.size === 0) {
      console.log("[Network] No active downloads to abort.");
      return;
    }

    // Abort each active download
    for (const [taskId, handle] of activeDownloads.entries()) {
      try {
        console.log(
          `[Network] Aborting active download for task ID: ${taskId}`,
        );
        handle.abort();
      } catch (e) {
        console.error(`[Network] Error while aborting task ${taskId}:`, e);
      }
    }

    // The 'onabort' handler in gmFetchWithRetry will reject the promise,
    // which then triggers the 'failed' status update.
    // We can clear the map here as all requests have been told to abort.
    activeDownloads.clear();
    console.log("[Network] All active downloads have been aborted.");
  }

  /**
   * Handles the browser's 'online' event. Finds all failed tasks and
   * creates a new download batch for them in a new window.
   */
  async function handleConnectionRestored(): Promise<void> {
    console.log(
      "[Network] Connection restored. Checking for failed downloads to restart.",
    );

    const tasksToRestart: SelectedTask[] = [];
    const originalTasksToUpdate: {
      task: ProgressTaskItem;
      windowId: string;
    }[] = [];

    // Collect all failed tasks from all progress windows
    for (const windowId in progressWindows) {
      const pwData = progressWindows[windowId];
      const isCompleted = pwData.tasks.every((t) => t.status === "completed");
      if (isCompleted) {
        continue; // Skip fully completed windows
      }

      pwData.tasks.forEach((task) => {
        if (task.status === "failed") {
          // Ensure we don't add the same task twice
          if (!tasksToRestart.some((rt) => rt.id === task.id)) {
            tasksToRestart.push({
              id: task.id,
              name: task.name,
              bv: task.bv,
              marked: false,
            });
            originalTasksToUpdate.push({ task, windowId });
          }
        }
      });
    }

    if (tasksToRestart.length > 0) {
      console.log(
        `[Network] Found ${tasksToRestart.length} failed tasks. Creating a new download batch.`,
      );

      // Update the UI of the original failed tasks to show they are being handled
      originalTasksToUpdate.forEach(({ task, windowId }) => {
        updateTaskStateById(windowId, task.id, { status: "restarted" as any });
      });

      // Start a new download process for the failed tasks
      startDownloadBatch(tasksToRestart);
      alert(
        `网络已恢复, 已为 ${tasksToRestart.length} 个失败的任务开启了新的下载批次。`,
      );
    } else {
      console.log("[Network] No failed tasks found to restart.");
    }
  }
  function handleTabClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const nId = target.dataset.tabId;
    if (!nId || nId === currentTabId) return;

    if (
      currentTabId &&
      tabStates[currentTabId] &&
      taskListContainer &&
      tabsContainer
    ) {
      tabStates[currentTabId].taskScrollTop = taskListContainer.scrollTop;
      tabStates[currentTabId].tabScrollLeft = tabsContainer.scrollLeft;
    }

    currentTabId = nId;
    tabsContainer!
      .querySelectorAll(".task-selector-tab-item.active")
      .forEach((el) => el.classList.remove("active"));
    target.classList.add("active");

    if (!tabStates[currentTabId])
      tabStates[currentTabId] = {
        taskScrollTop: 0,
        tabScrollLeft: 0,
        needsRender: false,
        lastRenderedScrollTop: -1,
      };

    renderTasksForCurrentTab(true);
    if (tabsContainer)
      requestAnimationFrame(() => {
        tabsContainer!.scrollLeft =
          tabStates[currentTabId!]?.tabScrollLeft || 0;
      });
  }

  function toggleCollapse(event: MouseEvent): void {
    event.stopPropagation();
    const sCollapse = !windowState.collapsed;
    if (!container || !collapseIndicator) return;

    if (sCollapse) {
      if (!windowState.collapsed) {
        // Save dimensions if was expanded
        windowState.width = container.offsetWidth + "px";
        windowState.height = container.offsetHeight + "px";
      }
      container.classList.add("collapsed");
      collapseIndicator.textContent = "+";
      container.style.cursor = "grab";
    } else {
      container.classList.remove("collapsed");
      collapseIndicator.textContent = "−";
      container.style.cursor = "";
      if (header) header.style.cursor = "grab";
      container.style.width = windowState.width || "350px";
      container.style.height = windowState.height || "450px";
      requestAnimationFrame(() => {
        if (currentTabId && tabStates[currentTabId]) {
          tabStates[currentTabId].needsRender = true;
          tabStates[currentTabId].lastRenderedScrollTop = -1;
        }
        renderTasksForCurrentTab(true);
        if (tabsContainer)
          tabsContainer.scrollLeft =
            (currentTabId && tabStates[currentTabId]?.tabScrollLeft) || 0;
      });
    }
    windowState.collapsed = sCollapse;
  }

  // In TaskSelectScript
  function handleMouseDownTaskList(event: MouseEvent): void {
    const target = event.target as HTMLElement;

    // --- START OF FIX ---
    // Check if the mousedown occurred on a task item (parent or child).
    const clickedOnTaskItem = target.closest(".task-selector-task-item");

    if (clickedOnTaskItem) {
      // If the user clicked on a task, we should not start the drag-selection box.
      // Instead, we do nothing and allow the standard 'click' event to fire,
      // which will be handled by `handleChildTaskClick` or the parent task's toggles.
      // This prevents `event.preventDefault()` from being called and blocking the click.
      return;
    }
    // --- END OF FIX ---

    // The rest of the function will now only execute if the user clicked on the
    // background of the list, which is the correct behavior for starting a drag-selection.

    const containerRect = taskListContainer?.getBoundingClientRect();
    if (!containerRect || event.clientX > containerRect.right - 15) {
      // 15px for scrollbar
      return;
    }

    event.preventDefault();

    // --- NEW, EFFICIENT BLOCK ---
    event.preventDefault(); // Keep this

    isSelectingBox = true;
    // The complex loop is replaced by a single, clean line of code.
    // This creates a new Set containing a snapshot of the currently selected IDs.
    initialSelectedInTabForBoxOp = new Set(selectedTaskIds);

    selectionBoxStart = { x: event.clientX, y: event.clientY };

    if (!selectionBoxElement) {
      selectionBoxElement = document.createElement("div");
      selectionBoxElement.className = "task-selection-box";
      taskListContainer!.appendChild(selectionBoxElement);
    }

    const listContainerBoundingRect =
      taskListContainer!.getBoundingClientRect();
    const initialLeft =
      event.clientX -
      listContainerBoundingRect.left +
      taskListContainer!.scrollLeft;
    const initialTop =
      event.clientY -
      listContainerBoundingRect.top +
      taskListContainer!.scrollTop;

    Object.assign(selectionBoxElement.style, {
      left: `${initialLeft}px`,
      top: `${initialTop}px`,
      width: "0px",
      height: "0px",
      display: "block",
    });

    document.addEventListener("mousemove", handleMouseMoveSelectBox, {
      passive: false,
    });
    document.addEventListener("mouseup", handleMouseUpSelectBox);
    document.body.style.userSelect = "none";
  }

  function handleMouseMoveSelectBox(event: MouseEvent): void {
    if (!isSelectingBox || !selectionBoxElement || !taskListContainer) return;
    event.preventDefault();
    const lr = taskListContainer.getBoundingClientRect();
    const cX = event.clientX;
    const cY = event.clientY;

    const bsX = Math.min(selectionBoxStart.x, cX);
    const bsY = Math.min(selectionBoxStart.y, cY);
    const beX = Math.max(selectionBoxStart.x, cX);
    const beY = Math.max(selectionBoxStart.y, cY);

    const fbX = bsX - lr.left + taskListContainer.scrollLeft;
    const fbY = bsY - lr.top + taskListContainer.scrollTop;
    const fbW = beX - bsX;
    const fbH = beY - bsY;

    Object.assign(selectionBoxElement.style, {
      left: `${fbX}px`,
      top: `${fbY}px`,
      width: `${fbW}px`,
      height: `${fbH}px`,
    });
    updateSelectionFromBox(false);
  }

  // In TaskSelectScript
  function handleMouseUpSelectBox(): void {
    // 1. 检查 isSelectingBox 状态
    if (!isSelectingBox) {
      // 如果不是正在选择，可能说明之前的 mouseup 没正确处理，或者 mousedown 没正确设置
      console.warn(
        "handleMouseUpSelectBox called but isSelectingBox is false.",
      );
      // 尝试强制重置，以防万一
      document.removeEventListener("mousemove", handleMouseMoveSelectBox);
      document.removeEventListener("mouseup", handleMouseUpSelectBox);
      document.body.style.userSelect = ""; // 恢复文本选择
      if (selectionBoxElement) selectionBoxElement.style.display = "none";
      initialSelectedInTabForBoxOp = new Set();
      isSelectingBox = false; // 确保重置
      return;
    }
    console.log("handleMouseUpSelectBox triggered. Finalizing selection.");

    // 2. 重置 isSelectingBox 状态 *在处理完选择之后，但在移除监听器之前或之后都可以*
    // 顺序：更新选择 -> 隐藏选择框 -> 移除监听器 -> 重置状态
    // isSelectingBox = false; // 移动到末尾确保所有操作完成
    // In handleMouseUpSelectBox
    try {
      updateSelectionFromBox(true); // isFinal = true
    } catch (error) {
      console.error("Error during updateSelectionFromBox in mouseup:", error);
    } finally {
      if (selectionBoxElement) {
        selectionBoxElement.style.display = "none";
      }
      document.removeEventListener("mousemove", handleMouseMoveSelectBox);
      document.removeEventListener("mouseup", handleMouseUpSelectBox);
      document.body.style.userSelect = "";
      initialSelectedInTabForBoxOp = new Set();
      isSelectingBox = false; // Ensure this is always reset
      selectionBoxElement = null;

      console.log("Drag selection cleanup completed in finally block.");
    }
  }

  function handleChildTaskClick(event: MouseEvent): void {
    event.stopPropagation();
    const targetItem = event.currentTarget as HTMLDivElement;
    const childTaskId = targetItem.dataset.taskId as string;
    const parentBvId = targetItem.dataset.bv as string;
    const parentMediaId = targetItem.dataset.mediaId as string; // Corrected from your file

    if (!childTaskId || !parentBvId) return;

    // Ignore clicks on already processed tasks
    if (markedTaskIds.has(childTaskId)) {
      return;
    }

    // Simple toggle logic using the Set
    if (selectedTaskIds.has(childTaskId)) {
      selectedTaskIds.delete(childTaskId);
      targetItem.classList.remove("selected");
    } else {
      selectedTaskIds.add(childTaskId);
      targetItem.classList.add("selected");
    }

    // Sync with BiliSelectScript (this logic doesn't change)
    if (window.BiliSelectScriptAPI) {
      const anyChildStillSelected =
        TaskSelectorManager.isAnyTaskSelectedForBv(parentBvId);
      window.BiliSelectScriptAPI.selectVideoCardByBv(
        parentBvId,
        anyChildStillSelected,
        true,
        parentMediaId,
      );
    }
  }

  // Helper to find a child task by its CID across all tabs/parent tasks
  function findChildTaskByIdGlobal(childId: string): Task | null {
    // This is now an instant O(1) lookup.
    return taskMap.get(childId) || null;
  }
  // `findTaskByIdGlobal` might need to be renamed or rethought if its previous meaning was different.
  // The original `findTaskByIdGlobal` might have been looking for what are now parent tasks by their 'id' (which was BV).
  // Now, selection is by CID.

  // In TaskSelectScript
  function updateSelectionFromBox(isFinal: boolean = false): void {
    if (!selectionBoxElement || (!isSelectingBox && !isFinal)) return;

    const boxRectVP = selectionBoxElement.getBoundingClientRect();
    if (boxRectVP.width === 0 && boxRectVP.height === 0 && !isFinal) return;

    const childTaskItems = taskListContainer?.querySelectorAll<HTMLDivElement>(
      ".task-selector-child-task",
    );
    if (!childTaskItems || childTaskItems.length === 0) return;

    const bvsAffected = new Set<string>();

    childTaskItems.forEach((item) => {
      const itemRectVP = item.getBoundingClientRect();
      const childTaskId = item.dataset.taskId;
      const parentBvId = item.dataset.bv;

      if (!childTaskId || !parentBvId) return;
      if (markedTaskIds.has(childTaskId)) return; // Don't change marked tasks

      const overlaps = !(
        itemRectVP.right < boxRectVP.left ||
        itemRectVP.left > boxRectVP.right ||
        itemRectVP.bottom < boxRectVP.top ||
        itemRectVP.top > boxRectVP.bottom
      );

      const wasInitiallySelected =
        initialSelectedInTabForBoxOp.has(childTaskId);

      if (isFinal) {
        // --- Final selection logic (on mouseup) ---
        if (overlaps) {
          if (wasInitiallySelected) {
            // It was selected, so the drag operation DESELECTS it.
            selectedTaskIds.delete(childTaskId);
          } else {
            // It was not selected, so the drag operation SELECTS it.
            selectedTaskIds.add(childTaskId);
          }
        }
        // After the drag, ensure the item's visual state matches the final truth.
        item.classList.toggle("selected", selectedTaskIds.has(childTaskId));
        bvsAffected.add(parentBvId);
      } else {
        // --- Preview logic (on mousemove) ---
        if (overlaps) {
          // If overlapping, its state is the INVERSE of its initial state.
          item.classList.toggle("selected", !wasInitiallySelected);
        } else {
          // If not overlapping, its state REVERTS to its initial state.
          item.classList.toggle("selected", wasInitiallySelected);
        }
      }
    });

    if (isFinal && window.BiliSelectScriptAPI) {
      bvsAffected.forEach((bvIdToUpdate) => {
        const shouldBeSelectedInBili =
          TaskSelectorManager.isAnyTaskSelectedForBv(bvIdToUpdate);
        window.BiliSelectScriptAPI!.selectVideoCardByBv(
          bvIdToUpdate,
          shouldBeSelectedInBili,
          true,
          // This part is slightly fragile, might need a better way to get mediaId
          childTaskItems[0]?.dataset.mediaId,
        );
      });
    }
  }

  function handleTaskListScroll(): void {
    if (!taskListContainer || !currentTabId || !tabStates[currentTabId]) return;
    const state = tabStates[currentTabId];
    state.taskScrollTop = taskListContainer.scrollTop;
    state.needsRender = true;
    scheduleTick();
  }

  function handleTabsScroll(): void {
    if (!tabsContainer || !currentTabId || !tabStates[currentTabId]) return;
    tabStates[currentTabId].tabScrollLeft = tabsContainer.scrollLeft;
  }
  const debouncedTabsScrollSave = debounce(handleTabsScroll, 150);

  // --- Button Actions ---
  /**
   * Initiates a download process for a given array of tasks.
   * Creates a new progress window and calls the main download function.
   * @param tasksToStart The tasks to include in the batch.
   * @returns The ID of the new progress window, or undefined if no tasks were provided.
   */
  function startDownloadBatch(
    tasksToStart: SelectedTask[],
  ): string | undefined {
    if (tasksToStart.length === 0) {
      return undefined;
    }

    console.log(
      `Starting a new download batch for ${tasksToStart.length} tasks.`,
    );

    // Create the task objects for the new progress window
    const progressTasks = tasksToStart.map((st) => ({
      id: st.id,
      name: st.name,
      bv: st.bv,
      marked: false,
      progress: 0,
      windowId: "",
      status: "pending" as TaskDownloadStatus,
    }));

    const newWindowId = createProgressWindow(progressTasks);
    console.log(`Created progress window for new batch: ${newWindowId}`);

    // Prepare tasks for the download function
    const tasksForDownload: Record<string, SelectedTask> = {};
    tasksToStart.forEach((task) => {
      tasksForDownload[task.id] = { ...task, marked: true };
    });

    // Call the main download function
    download(tasksForDownload, newWindowId);

    return newWindowId;
  }
  function confirmSelection(): string | undefined {
    // 1. Get tasks to process directly from the selectedTaskIds Set.
    const tasksToProcess = Array.from(selectedTaskIds)
      .map((id) => findChildTaskByIdGlobal(id)!)
      .filter(Boolean);

    if (tasksToProcess.length === 0) return undefined;

    console.log(`Confirming ${tasksToProcess.length} sub-tasks.`);

    // 2. Move the IDs from 'selected' to 'marked'.
    tasksToProcess.forEach((task) => {
      selectedTaskIds.delete(task.id);
      markedTaskIds.add(task.id);
    });

    // 3. The data for the progress window is clean.
    const progressTasks = tasksToProcess.map((st) => ({
      id: st.id,
      name: st.name,
      bv: st.bv,
      marked: false, // This is for the progress window's own state, always start at false.
    }));

    const nId = createProgressWindow(progressTasks);
    console.log(`Created progress window: ${nId}`);

    // 4. Trigger a re-render to update styles from "selected" to "marked".
    renderTasksForCurrentTab(true);

    // 5. Create a temporary object for the download function based on marked tasks.
    // (The download function itself can be refactored later to accept an array).
    const tasksForDownload: Record<string, SelectedTask> = {};
    markedTaskIds.forEach((id) => {
      const taskData = findChildTaskByIdGlobal(id);
      if (taskData) {
        tasksForDownload[id] = { ...taskData, marked: true };
      }
    });

    download(tasksForDownload, nId);
    console.log(
      "Selection confirmed. Active selection cleared, tasks are now marked for processing.",
    );
    return nId;
  }

  // In --- Button Actions --- section, replace the old download function with this one.

  async function download(
    tasksToDownload: Record<string, SelectedTask>,
    wid: string,
  ): Promise<void> {
    const zip = new JSZip();
    let localBlobUrlForCleanup: string | null = null;
    const tasksArray = Object.values(tasksToDownload);

    // --- 1. Extract the single-task logic into its own async function ---
    // This function will be the "executor" for our pool.
    // 在 download 函数内部的 processSingleDownload

    const processSingleDownload = async (
      task: SelectedTask,
    ): Promise<string> => {
      const taskId = String(task.id);

      try {
        // --- Step A: 获取视频信息 (API调用) ---
        // 这个也可以重试，但通常不是主要问题，这里保持原样或简化
        updateTaskStateById(wid, taskId, {
          status: "downloading",
          progress: 5,
        }); // 状态: 开始获取信息
        const videoInfoText = await gmFetchWithRetry<string>(
          {
            method: "GET",
            url: `https://api.bilibili.com/x/player/playurl?bvid=${task.bv}&cid=${task.id}&qn=116&type=&otype=json&platform=html5&high_quality=1`,
            headers: {
              Referer: `https://www.bilibili.com/video/${task.bv}`,
              "User-Agent": navigator.userAgent,
            },
            responseType: "text",
            timeout: 30000, // 30 second timeout for API call
          },
          DOWNLOAD_RETRY_ATTEMPTS,
          DOWNLOAD_RETRY_DELAY_MS,
        );

        const jsonResponse = JSON.parse(videoInfoText);
        // ... 错误检查 ...
        const videoUrl = jsonResponse.data.durl[0].url;

        // --- Step B: 下载视频 Blob ---
        updateTaskStateById(wid, taskId, { progress: 10 }); // 状态: 准备下载
        try {
          const videoBlob = await gmFetchWithRetry<Blob>(
            {
              method: "GET",
              url: videoUrl,
              responseType: "blob",
              headers: { Referer: "https://www.bilibili.com/" },
              timeout: 600000,
            },
            DOWNLOAD_RETRY_ATTEMPTS,
            DOWNLOAD_RETRY_DELAY_MS,
            {
              onStart: (handle) => {
                // --- KEY CHANGE: Start tracking the download ---
                activeDownloads.set(taskId, handle);
                console.log(
                  `[Download] Started tracking active download for task: ${task.name}`,
                );
              },
              // 关键：在这里提供回调
              onProgress: (progressEvent: any) => {
                if (progressEvent.lengthComputable) {
                  const percent = Math.round(
                    (progressEvent.loaded / progressEvent.total) * 100,
                  );
                  // 下载时，状态是 'downloading'
                  updateTaskStateById(wid, taskId, {
                    status: "downloading",
                    progress: percent,
                  });
                }
              },
              onRetry: (attempt: number, error: any) => {
                console.log(
                  `[Pool] 任务 ${task.name} 第 ${attempt} 次重试，原因:`,
                  error.message,
                );
                // 状态变为 'retrying'，进度可以归零或保持
                updateTaskStateById(wid, taskId, {
                  status: "retrying",
                  progress: 0,
                });
              },
            },
          );

          // --- Step C: 添加到 Zip ---
          if (videoBlob && videoBlob.size > 0) {
            zip.file(task.name + ".mp4", videoBlob);
            // 最终状态: completed
            updateTaskStateById(wid, taskId, {
              status: "completed",
              progress: 100,
            });
            return `成功: ${task.name}`;
          } else {
            // 如果blob为空，也标记为失败
            throw new Error("Downloaded blob is empty or invalid.");
          }
        } finally {
          // --- KEY CHANGE: Stop tracking when done (success or failure) ---
          if (activeDownloads.has(taskId)) {
            activeDownloads.delete(taskId);
            console.log(
              `[Download] Stopped tracking download for task: ${task.name}`,
            );
          }
        }
      } catch (err: any) {
        console.error(
          `[Pool] 任务 ${task.name} 在所有重试后失败:`,
          err.message,
        );
        // 最终状态: failed
        updateTaskStateById(wid, taskId, { status: "failed", progress: 0 });
        // Ensure it's not still being tracked in case of an unexpected error
        if (activeDownloads.has(taskId)) {
          activeDownloads.delete(taskId);
        }
        throw err; // 仍然需要抛出错误以停止 Promise.all
      }
    };
    // --- 2. Main execution block ---
    console.log(
      `所有任务已启动，将以 ${MAX_CONCURRENT_DOWNLOADS} 的并发数运行...`,
    );
    try {
      // --- Use the pool runner instead of Promise.all(map(...)) ---
      const results = await runPromisesInPool(
        tasksArray,
        processSingleDownload,
        MAX_CONCURRENT_DOWNLOADS,
      );

      console.log("所有下载任务处理完成！");
      console.log("处理结果:", results);

      // --- 3. The rest of the function (zipping and download link) remains the same ---
      console.log("开始生成ZIP文件...");
      const zipBlob = await zip.generateAsync(
        {
          type: "blob",
          compression: "DEFLATE",
          compressionOptions: { level: 1 },
        }, // Use lower compression for speed
        (metadata) => {
          console.log(
            `正在压缩: ${Math.round(metadata.percent)}%, 文件: ${metadata.currentFile}`,
          );
        },
      );
      console.log("ZIP文件生成成功，准备下载...");

      localBlobUrlForCleanup = window.URL.createObjectURL(zipBlob);

      const newWindow = window.open("", "_blank");
      if (newWindow) {
        try {
          // 1. Get the document of the new window.
          const newDoc = newWindow.document;

          // 2. Set the title of the new window's document.
          newDoc.title = "Download File";

          // 3. Create a <style> element and add the CSS rules.
          const style = newDoc.createElement("style");
          style.textContent = `
                body {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    margin: 0;
                    font-family: sans-serif;
                    background-color: #f8f9fa;
                }
                a {
                    font-size: 1.5em;
                    padding: 15px 30px;
                    border: 1px solid #ccc;
                    text-decoration: none;
                    color: #007bff;
                    background-color: #fff;
                    border-radius: 5px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    transition: all 0.2s ease-in-out;
                }
                a:hover {
                    background-color: #f0f0f0;
                    transform: translateY(-2px);
                    box-shadow: 0 4px 8px rgba(0,0,0,0.15);
                }
            `;
          // 4. Append the style to the <head> of the new document.
          newDoc.head.appendChild(style);

          // 5. Create the <a> element for the download link.
          const link = newDoc.createElement("a");
          link.href = localBlobUrlForCleanup;
          link.textContent = "Download Generated ZIP";
          // The 'download' attribute is crucial; it tells the browser to download the file.
          link.download = "downloaded_mp4s.zip";

          // 6. Append the link to the <body> of the new document.
          newDoc.body.appendChild(link);

          // 7. Focus the new window to bring it to the user's attention.
          newWindow.focus();

          // The timeout to revoke the blob URL remains the same.
          setTimeout(() => {
            if (localBlobUrlForCleanup) {
              console.log("Revoking Blob URL (timer):", localBlobUrlForCleanup);
              URL.revokeObjectURL(localBlobUrlForCleanup);
              localBlobUrlForCleanup = null;
            }
          }, 480 * 1000); // 8 minutes
        } catch (err) {
          console.error("Error writing to the new window:", err);
          alert("无法写入新窗口的内容。可能是安全限制。");
          newWindow.close();
          if (localBlobUrlForCleanup) {
            URL.revokeObjectURL(localBlobUrlForCleanup);
            localBlobUrlForCleanup = null;
          }
        }
      } else {
        alert(
          "无法打开新窗口。\n请检查您的浏览器设置，确保允许来自此站点的弹出窗口。",
        );
        if (localBlobUrlForCleanup) {
          URL.revokeObjectURL(localBlobUrlForCleanup);
          localBlobUrlForCleanup = null;
        }
      }
    } catch (error) {
      console.error("下载过程中发生严重错误，已停止:", error);
      alert(
        "下载池中的一个任务失败，整个过程已停止。请检查控制台获取详细信息。",
      );
      if (localBlobUrlForCleanup) {
        URL.revokeObjectURL(localBlobUrlForCleanup);
        localBlobUrlForCleanup = null;
      }
    }
  }

  function selectVisibleTasks(): void {
    if (!taskListContainer || windowState.collapsed) return;

    const containerRect = taskListContainer.getBoundingClientRect();
    // Querying for child tasks is correct, as they are the only selectable items.
    const childTaskItems = taskListContainer.querySelectorAll<HTMLDivElement>(
      ".task-selector-child-task",
    );

    let newlySelectedCount = 0;
    const affectedBvIds = new Set<string>();

    childTaskItems.forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const taskId = item.dataset.taskId;
      const parentBvId = item.dataset.bv;

      if (!taskId || !parentBvId) {
        return;
      }

      const isVisible =
        itemRect.top < containerRect.bottom &&
        itemRect.bottom > containerRect.top;

      // --- KEY CHANGE HERE ---
      // The condition is now much simpler and clearer.
      // We select it if it's visible AND not in EITHER of our state Sets.
      if (
        isVisible &&
        !selectedTaskIds.has(taskId) &&
        !markedTaskIds.has(taskId)
      ) {
        // 1. Update the UI. We only need to add 'selected'.
        item.classList.add("selected");

        // 2. Update the application's state. This is now a single, simple operation.
        selectedTaskIds.add(taskId);

        newlySelectedCount++;
        affectedBvIds.add(parentBvId);
      }
    });

    // 3. Sync state with the BiliSelect script (this logic remains the same).
    if (newlySelectedCount > 0 && window.BiliSelectScriptAPI) {
      affectedBvIds.forEach((bvId) => {
        window.BiliSelectScriptAPI?.selectVideoCardByBv(bvId, true, true);
      });
    }

    console.log(
      `Selected ${newlySelectedCount} visible tasks. Total active selections: ${selectedTaskIds.size}`,
    );
  }

  function deselectVisibleTasks(): void {
    if (!taskListContainer || windowState.collapsed) return;

    const containerRect = taskListContainer.getBoundingClientRect();
    const childTaskItems = taskListContainer.querySelectorAll<HTMLDivElement>(
      ".task-selector-child-task",
    );

    let deselectedCount = 0;
    // We'll gather all parent BVs whose children were deselected.
    const bvsToUpdate = new Set<string>();

    childTaskItems.forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const taskId = item.dataset.taskId;
      const parentBvId = item.dataset.bv;

      if (!taskId || !parentBvId) return;

      const isVisible =
        itemRect.top < containerRect.bottom &&
        itemRect.bottom > containerRect.top;

      // --- KEY CHANGE HERE ---
      // The condition to act is simple: Is the item visible AND is its ID in our selection Set?
      if (isVisible && selectedTaskIds.has(taskId)) {
        // 1. Update the application state by removing the ID.
        selectedTaskIds.delete(taskId);

        // 2. Update the UI by removing the 'selected' class.
        item.classList.remove("selected");

        // 3. Track our changes for the final summary and sync.
        deselectedCount++;
        bvsToUpdate.add(parentBvId);
      }
    });

    // --- SYNC LOGIC ---
    // If we actually deselected anything, we need to check if the parent video
    // cards on the main page should also be deselected.
    if (deselectedCount > 0 && window.BiliSelectScriptAPI) {
      bvsToUpdate.forEach((bvId) => {
        // Check if ANY OTHER task for this BV is still selected.
        const anyOtherTaskForBvIsSelected =
          TaskSelectorManager.isAnyTaskSelectedForBv(bvId);

        // Only deselect the card if NO tasks for this BV remain in the selection.
        if (!anyOtherTaskForBvIsSelected) {
          window.BiliSelectScriptAPI!.selectVideoCardByBv(bvId, false, true);
        }
      });
    }

    console.log(
      `Deselected ${deselectedCount} visible tasks. Total active selections: ${selectedTaskIds.size}`,
    );
  }
  function deselectAllTasks(): void {
    // If there's nothing selected, there's nothing to do.
    if (selectedTaskIds.size === 0) {
      console.log("Deselect All: No tasks were selected.");
      return;
    }

    const bvsToUpdate = new Set<string>();

    // 1. Efficiently gather all parent BV IDs before clearing the selection.
    // This leverages our new instant O(1) taskMap lookup.
    for (const taskId of selectedTaskIds) {
      const taskData = taskMap.get(taskId); // Fast lookup
      if (taskData) {
        bvsToUpdate.add(taskData.bv);
      }
    }

    // 2. The core state change: clear the entire selection Set in one go.
    const deselectedCount = selectedTaskIds.size;
    selectedTaskIds.clear();

    // 3. Trigger a full re-render to remove all 'selected' styles from the UI.
    renderTasksForCurrentTab(true);

    // 4. Sync the changes with the BiliSelectScript on the main page.
    if (window.BiliSelectScriptAPI) {
      bvsToUpdate.forEach((bvId) => {
        // Since we are deselecting ALL, the `shouldSelect` parameter is always false.
        window.BiliSelectScriptAPI!.selectVideoCardByBv(bvId, false, true);
      });
    }

    console.log(`Deselected ${deselectedCount} tasks globally.`);
  }
  function selectAllTasksInTab(): void {
    if (!currentTabId || !allTasksData[currentTabId]) return;
    const parentTasksInCurrentTab = allTasksData[currentTabId].tasks;
    const bvsToUpdate = new Set<string>();
    let changed = false;

    parentTasksInCurrentTab.forEach((pt) => {
      pt.children.forEach((child) => {
        // Add to set if it's not already selected or marked
        if (!selectedTaskIds.has(child.id) && !markedTaskIds.has(child.id)) {
          selectedTaskIds.add(child.id);
          changed = true;
        }
      });
      if (pt.children.length > 0) bvsToUpdate.add(pt.bv);
    });

    if (changed) {
      renderTasksForCurrentTab(true); // Re-render to update UI
      if (window.BiliSelectScriptAPI) {
        bvsToUpdate.forEach((bvId) => {
          window.BiliSelectScriptAPI!.selectVideoCardByBv(bvId, true, true);
        });
      }
      console.log(`Selected all available sub-tasks in tab ${currentTabId}.`);
    }
  }
  // --- Progress Window Functions ---
  function createProgressWindow(tasksForWindow: SelectedTask[]): string {
    progressWindowCounter++;
    const windowId = `progress-window-${progressWindowCounter}`;

    const preparedTasks: ProgressTaskItem[] = tasksForWindow.map((t) => ({
      ...t,
      progress: 0,
      windowId: windowId,
      status: "pending", // 设置初始状态
    }));

    const state: ProgressWindowState = {
      id: windowId,
      top: `${50 + progressWindowCounter * 15}px`,
      left: `${50 + progressWindowCounter * 15}px`,
      width: "300px",
      height: "250px",
      // tasks: preparedTasks, // tasks are stored in ProgressWindowData now
      scrollTop: 0,
      needsRender: false,
      lastRenderedScrollTop: -1,
    };

    const pwC = document.createElement("div");
    pwC.id = windowId;
    pwC.className = "task-progress-window";
    pwC.setAttribute("draggable", "false");
    Object.assign(pwC.style, {
      top: state.top,
      left: state.left,
      width: state.width,
      height: state.height,
    });

    const pwH = document.createElement("div");
    pwH.className = "task-progress-header";
    pwH.setAttribute("draggable", "false");
    pwH.innerHTML = `<span class="task-progress-title">任务进度 (${preparedTasks.length})</span>`;

    const pwX = document.createElement("div");
    pwX.className = "task-progress-close-btn";
    pwX.textContent = "✕";
    pwX.title = "关闭窗口";
    pwX.addEventListener("click", (event: MouseEvent) => {
      event.stopPropagation();
      closeProgressWindow(windowId);
    });
    pwH.appendChild(pwX);

    const pwL = document.createElement("div");
    pwL.className = "task-progress-list-container";

    const pwR = document.createElement("div");
    pwR.className = "task-progress-resizer";

    pwC.append(pwH, pwL, pwR);
    document.body.appendChild(pwC);

    const cleanupFunctions: (() => void)[] = [];

    // Create drag handler and store its cleanup function
    const destroyDragHandler = createDragHandler({
      triggerElement: pwH,
      movableElement: pwC,
      state: state, // Pass the window's specific state object
    });
    cleanupFunctions.push(destroyDragHandler);

    // Create resize handler and store its cleanup function
    const destroyResizeHandler = createResizeHandler({
      resizeHandleElement: pwR,
      resizableElement: pwC,
      state: state, // Pass the window's specific state object
      onResize: () => {
        if (progressWindows[windowId]?.state)
          progressWindows[windowId].state.needsRender = true;
        scheduleTick();
      },
      onResizeEnd: () => {
        if (progressWindows[windowId]?.state) {
          progressWindows[windowId].state.needsRender = true;
          progressWindows[windowId].state.lastRenderedScrollTop = -1;
        }
        scheduleTick();
      },
    });
    cleanupFunctions.push(destroyResizeHandler);
    // The progressWindows object is now much simpler
    progressWindows[windowId] = {
      element: pwC,
      listElement: pwL,
      closeButton: pwX,
      tasks: preparedTasks,
      state: state,
      checkCompletion: () => checkProgressCompletion(windowId),
      updateProgress: (tid, p) => updateTaskProgressById(windowId, tid, p),
      renderItems: (f = false) => renderProgressItems(windowId, f),
      handleScroll: () => handleProgressScroll(windowId),
      cleanupFunctions: cleanupFunctions, // Store the array of cleanup functions
    };

    pwL.addEventListener("scroll", progressWindows[windowId].handleScroll, {
      passive: true,
    });

    renderProgressItems(windowId, true);
    progressWindows[windowId].checkCompletion();
    return windowId;
  }

  // Replace the entire old function with this new one

  function closeProgressWindow(windowId: string): void {
    const pw = progressWindows[windowId];
    if (!pw?.element) return;

    // 1. Execute all stored cleanup functions.
    // This will remove the 'mousedown' listeners for drag and resize.
    pw.cleanupFunctions.forEach((cleanup) => cleanup());

    // 2. Remove any other listeners attached directly.
    pw.listElement?.removeEventListener("scroll", pw.handleScroll);

    // 3. Remove the element from the DOM.
    pw.element.remove();

    // 4. Delete the window's data from our state.
    delete progressWindows[windowId];
  }
  // 新的、更强大的内部更新函数
  function updateTaskStateById(
    windowId: string,
    taskId: string,
    newState: Partial<Pick<ProgressTaskItem, "progress" | "status">>,
  ): void {
    const pw = progressWindows[windowId];
    if (!pw) return;

    const taskItem = pw.tasks.find((t) => t.id === taskId);
    if (taskItem) {
      // 更新状态
      if (newState.progress !== undefined) {
        taskItem.progress = Math.max(0, Math.min(100, newState.progress));
      }
      if (newState.status !== undefined) {
        taskItem.status = newState.status;
      }

      // 更新 DOM
      const itemNode = pw.listElement?.querySelector<HTMLDivElement>(
        `.task-progress-item[data-task-id="${taskId}"]`,
      );
      if (itemNode) {
        const progressBar =
          itemNode.querySelector<HTMLDivElement>(".task-progress-bar");
        if (progressBar) {
          progressBar.style.width = `${taskItem.progress}%`;
          // 移除所有旧的状态类
          progressBar.className = "task-progress-bar";
          // 添加当前状态的类
          progressBar.classList.add(`status-${taskItem.status}`);
        }

        // (可选) 更新状态文本
        let statusTextElem = itemNode.querySelector<HTMLSpanElement>(
          ".task-progress-item-status-text",
        );
        if (
          taskItem.status !== "downloading" &&
          taskItem.status !== "pending" &&
          taskItem.status !== "completed"
        ) {
          if (!statusTextElem) {
            statusTextElem = document.createElement("span");
            statusTextElem.className = "task-progress-item-status-text";
            const nameElem = itemNode.querySelector(".task-progress-item-name");
            nameElem?.appendChild(statusTextElem);
          }
          let text = "";
          if (taskItem.status === "retrying") text = " (重试中...)";
          if (taskItem.status === "failed") text = " (下载失败)";
          // ADD THIS LINE
          if (taskItem.status === "restarted") text = " (已在新批次中重启)";
          statusTextElem.textContent = text;
          statusTextElem.textContent = text;
        } else if (statusTextElem) {
          statusTextElem.textContent = ""; // 清除文本
        }
      }

      // 检查整体完成情况
      if (newState.status === "completed" || newState.status === "failed") {
        pw.checkCompletion();
      }
    }
  }

  function updateTaskProgressById(wId: string, tId: string, p: number): void {
    updateTaskStateById(wId, tId, { progress: p });
  }

  function checkProgressCompletion(wId: string): void {
    const pw = progressWindows[wId];
    if (!pw?.closeButton) return;
    // 当所有任务都完成或失败时，显示关闭按钮
    const allDone = pw.tasks.every(
      (t) => t.status === "completed" || t.status === "failed",
    );
    pw.closeButton.classList.toggle("visible", allDone);
  }

  function renderProgressItems(
    wId: string,
    forceUpdate: boolean = false,
  ): void {
    const pwData = progressWindows[wId];
    const pwState = pwData?.state;
    if (!pwData?.listElement || !pwState) return;

    const tasks = pwData.tasks;
    const listContainer = pwData.listElement;
    const scrollTop = listContainer.scrollTop;
    const containerHeight = listContainer.clientHeight;

    pwState.scrollTop = scrollTop;

    if (containerHeight <= 0 && !forceUpdate) return;

    const startIndex = Math.max(
      0,
      Math.floor(scrollTop / PROGRESS_ITEM_HEIGHT) -
        PROGRESS_VISIBLE_ITEMS_BUFFER,
    );
    const endIndex = Math.min(
      tasks.length,
      Math.ceil((scrollTop + containerHeight) / PROGRESS_ITEM_HEIGHT) +
        PROGRESS_VISIBLE_ITEMS_BUFFER,
    );

    const fragment = document.createDocumentFragment();
    listContainer.innerHTML = ""; // Clear

    const paddingTop = startIndex * PROGRESS_ITEM_HEIGHT;
    const paddingBottom = (tasks.length - endIndex) * PROGRESS_ITEM_HEIGHT;

    const topSpacer = document.createElement("div");
    topSpacer.style.height = `${paddingTop}px`;
    fragment.appendChild(topSpacer);

    for (let i = startIndex; i < endIndex; i++) {
      if (tasks[i]) {
        const t = tasks[i];
        const it = document.createElement("div");
        it.className = "task-progress-item";
        it.dataset.taskId = t.id;
        it.dataset.bv = t.bv;
        it.setAttribute("draggable", "false");

        const nS = document.createElement("div");
        nS.className = "task-progress-item-name";
        nS.textContent = t.name;

        const bC = document.createElement("div");
        bC.className = "task-progress-bar-container";
        const b = document.createElement("div");
        b.className = "task-progress-bar";
        const cP = t.progress || 0;
        b.style.width = `${cP}%`;
        b.classList.toggle("completed", cP === 100);
        bC.appendChild(b);

        it.append(nS, bC);
        fragment.appendChild(it);
      }
    }

    const bottomSpacer = document.createElement("div");
    bottomSpacer.style.height = `${paddingBottom}px`;
    fragment.appendChild(bottomSpacer);

    listContainer.appendChild(fragment);

    pwState.lastRenderedScrollTop = scrollTop;
    pwState.needsRender = false;

    if (forceUpdate) {
      const forcedScrollTop = pwState.scrollTop ?? 0;
      requestAnimationFrame(() => {
        if (listContainer && progressWindows[wId]) {
          // Check if window still exists
          listContainer.scrollTop = forcedScrollTop;
          if (progressWindows[wId]) {
            // Check again as RAF is async
            progressWindows[wId].state.lastRenderedScrollTop =
              listContainer.scrollTop;
          }
        }
      });
    }
  }

  function handleProgressScroll(windowId: string): void {
    const pwData = progressWindows[windowId];
    const pwState = pwData?.state;
    if (!pwData?.listElement || !pwState) return;
    pwState.scrollTop = pwData.listElement.scrollTop;
    pwState.needsRender = true;
    scheduleTick();
  }

  // --- Helper Functions ---

  // --- Initialization ---
  function init(): void {
    if (container) return; // Already initialized
    injectStyles();

    container = document.createElement("div");
    container.className = "task-selector-container";
    container.setAttribute("draggable", "false"); // Prevent native drag
    container.style.top = windowState.top;
    container.style.left = windowState.left;
    // width and height will be set later based on collapsed state

    header = document.createElement("div");
    header.className = "task-selector-header";
    header.setAttribute("draggable", "false");
    header.innerHTML =
      '<span class="task-selector-header-title">任务选择器</span>';

    collapseIndicator = document.createElement("span");
    collapseIndicator.className = "task-selector-collapse-indicator";
    // textContent set later based on collapsed state
    header.appendChild(collapseIndicator);
    createDragHandler({
      triggerElement: header,
      movableElement: container,
      state: windowState,
    });
    collapseIndicator.addEventListener(
      "click",
      toggleCollapse as EventListener,
    );

    body = document.createElement("div");
    body.className = "task-selector-body";

    buttonsContainer = document.createElement("div");
    buttonsContainer.className = "task-selector-buttons";
    [
      {
        text: "确认选中",
        action: confirmSelection,
        title: "处理选中的任务并创建进度窗口",
      },
      {
        text: "选可见",
        action: selectVisibleTasks,
        title: "选择当前列表视区内所有任务",
      },
      {
        text: "全不选",
        action: deselectAllTasks,
        title: "取消选择所有分页中的全部任务",
      },
      {
        text: "去可见",
        action: deselectVisibleTasks,
        title: "取消选择当前列表视区内的任务",
      },
      {
        text: "选分页",
        action: selectAllTasksInTab,
        title: "选择当前分页下的所有任务",
      },
    ].forEach((bi) => {
      const b = document.createElement("button");
      b.textContent = bi.text;
      b.title = bi.title;
      b.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        bi.action();
      });
      buttonsContainer!.appendChild(b);
    });

    const cW = document.createElement("div");
    cW.className = "task-selector-content-wrapper";

    taskListContainer = document.createElement("div");
    taskListContainer.className = "task-selector-task-list-container";
    taskListContainer.addEventListener("scroll", handleTaskListScroll, {
      passive: true,
    });
    taskListContainer.addEventListener(
      "mousedown",
      handleMouseDownTaskList as EventListener,
    );

    // NEW: Add the spacer element for virtualization
    const spacer = document.createElement("div");
    spacer.className = "virtual-scroll-spacer";
    taskListContainer.appendChild(spacer);

    tabsContainer = document.createElement("div");
    tabsContainer.className = "task-selector-tabs-container";
    tabsContainer.addEventListener("scroll", debouncedTabsScrollSave, {
      passive: true,
    });

    const rsz = document.createElement("div");
    rsz.className = "task-selector-resizer";

    createResizeHandler({
      resizeHandleElement: rsz,
      resizableElement: container,
      state: windowState,
      onResize: () => {
        if (currentTabId && tabStates[currentTabId])
          tabStates[currentTabId].needsRender = true;
        scheduleTick();
      },
      onResizeEnd: () => {
        if (currentTabId && tabStates[currentTabId]) {
          tabStates[currentTabId].needsRender = true;
          tabStates[currentTabId].lastRenderedScrollTop = -1; // Force full re-render
        }
        scheduleTick();
      },
    });

    cW.append(taskListContainer, tabsContainer);
    body.append(buttonsContainer, cW);
    container.append(header, body, rsz);
    document.body.appendChild(container);

    // Apply initial collapsed state
    if (windowState.collapsed) {
      container.classList.add("collapsed");
      collapseIndicator.textContent = "+";
      container.style.cursor = "grab";
      container.style.width = "50px"; // Explicitly set collapsed dimensions
      container.style.height = "50px";
    } else {
      container.classList.remove("collapsed");
      collapseIndicator.textContent = "−";
      container.style.width = windowState.width;
      container.style.height = windowState.height;
      container.style.cursor = ""; // Default cursor for expanded
      if (header) header.style.cursor = "grab";
    }

    renderTabs();
    if (!windowState.collapsed && currentTabId) {
      renderTasksForCurrentTab(true); // Force render if initially expanded and tab exists
    }
    // Register network event listeners and add their cleanup to the global array
    const onlineHandler = handleConnectionRestored as EventListener;
    const offlineHandler = handleConnectionLost as EventListener;
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    globalCleanupFunctions.push(() =>
      window.removeEventListener("online", onlineHandler),
    );
    globalCleanupFunctions.push(() =>
      window.removeEventListener("offline", offlineHandler),
    );

    console.log("Task Selector Initialized.");
  }

  // --- Public API ---
  const TaskSelectorManager: TaskSelectorManagerAPI = {
    addTaskData: (
      tabId: string, // tabId
      tabName: string, // tabName
      parentTaskInputs: {
        videoTitle: string;
        bvId: string;
        pages: { cid: string; part: string }[];
      }[],
      autoSelectNewChildren: boolean = false,
    ) => {
      if (!tabId || !tabName || !Array.isArray(parentTaskInputs)) {
        console.error("Invalid addTaskData args");
        return;
      }
      const sId = String(tabId);
      let needsReRenderCurrentTab = false;
      let tabCreated = false;

      // Create tab data structure if it doesn't exist
      if (!allTasksData[sId]) {
        allTasksData[sId] = { name: tabName, tasks: [] };
        tabStates[sId] = {
          taskScrollTop: 0,
          tabScrollLeft: 0,
          needsRender: false,
          lastRenderedScrollTop: -1,
        };
        tabCreated = true;
        if (!currentTabId) currentTabId = sId;
      }

      const tabParentTasks = allTasksData[sId].tasks;

      parentTaskInputs.forEach((videoInput) => {
        // Check if this parent video (BV) already exists in this tab
        const existingParentTask = tabParentTasks.find(
          (pt) => pt.bv === videoInput.bvId,
        );

        if (existingParentTask) {
          // Parent task already exists. We won't add it again.
          // We'll still honor auto-selection for its children if requested.
          if (autoSelectNewChildren) {
            existingParentTask.children.forEach((childTask) => {
              if (!markedTaskIds.has(childTask.id)) {
                // Only select if not marked
                selectedTaskIds.add(childTask.id);
                needsReRenderCurrentTab = true;
              }
            });
          }
          return; // Skip to the next videoInput
        }

        // --- This is a NEW parent task, process it ---

        // 1. Create the child task data objects
        const children: Task[] = videoInput.pages.map((page) => ({
          id: String(page.cid),
          name: String(page.part),
          bv: videoInput.bvId,
        }));

        if (children.length === 0) {
          console.warn(
            `No pages found for BV ${videoInput.bvId}, title: ${videoInput.videoTitle}.`,
          );
          return;
        }

        // 2. Populate our global taskMap for fast lookups
        children.forEach((child) => {
          taskMap.set(child.id, child);
        });

        // 3. Create the new parent task object
        const newParentTask: ParentTask = {
          name: videoInput.videoTitle,
          bv: videoInput.bvId,
          children: children,
          isExpanded: false, // Default to collapsed
          MediaId: tabId,
        };
        tabParentTasks.push(newParentTask);
        needsReRenderCurrentTab = true;

        // 4. Handle auto-selection with our new Set
        if (autoSelectNewChildren) {
          newParentTask.children.forEach((childTask) => {
            selectedTaskIds.add(childTask.id);
          });
          console.log(
            `TaskSelectorManager: Auto-selected all children for new video BV ${videoInput.bvId}`,
          );
        }
      });

      // --- UI Update Logic ---
      if (tabCreated && tabsContainer) renderTabs();

      if (
        needsReRenderCurrentTab &&
        sId === currentTabId &&
        !windowState.collapsed &&
        taskListContainer
      ) {
        if (tabStates[sId]) {
          tabStates[sId].needsRender = true;
          tabStates[sId].lastRenderedScrollTop = -1;
        }
        scheduleTick();
      }
    },

    updateTaskProgress: (wId, tId, p) => {
      progressWindows[String(wId)]?.updateProgress(String(tId), p);
    },

    getSelectedTaskIds: () => {
      // Simply convert the Set to an array.
      return Array.from(selectedTaskIds);
    },

    // In isTaskSelected
    isTaskSelected: (taskId: string /* cid */): boolean => {
      // Direct, O(1) lookup.
      return selectedTaskIds.has(taskId);
    },

    // In isAnyTaskSelectedForBv
    isAnyTaskSelectedForBv: (bvId: string): boolean => {
      if (!bvId) return false;
      // This is the one place where we need to look up task data.
      // It highlights the need for the taskMap optimization.
      for (const taskId of selectedTaskIds) {
        const taskData = findChildTaskByIdGlobal(taskId); // Assumes findChildTaskByIdGlobal exists and is efficient
        if (taskData && taskData.bv === bvId) {
          return true; // Found a match
        }
      }
      return false;
    },

    destroy: () => {
      console.log("Destroying Task Selector...");
      if (!container) return;

      // 1. Execute all registered cleanup functions in one go.
      // This removes every single event listener we added.
      globalCleanupFunctions.forEach((cleanup) => cleanup());
      globalCleanupFunctions.length = 0; // Clear the array for any potential re-initialization.

      // 2. Close all child windows (this already uses the robust cleanup pattern).
      Object.keys(progressWindows).forEach(closeProgressWindow);

      // 3. Remove the main DOM elements.
      container.remove();
      document.getElementById("task-selector-styles")?.remove();

      // 4. Reset all state variables to their initial values.
      allTasksData = {};
      selectedTaskIds = new Set<string>();
      markedTaskIds = new Set<string>();
      taskMap = new Map<string, Task>();
      activeDownloads.clear();
      currentTabId = null;
      tabStates = {};
      windowState = {
        // Reset to default
        collapsed: true,
        top: "20px",
        left: "20px",
        width: "350px",
        height: "450px",
      };
      progressWindows = {};
      progressWindowCounter = 0;
      isSelectingBox = false;
      selectionBoxStart = { x: 0, y: 0 };
      initialSelectedInTabForBoxOp = new Set();
      tickScheduled = false;

      // 5. Nullify DOM element references to help garbage collection.
      container = null;
      header = null;
      body = null;
      taskListContainer = null;
      tabsContainer = null;
      buttonsContainer = null;
      collapseIndicator = null;
      selectionBoxElement = null;

      // 6. Remove the API from the window object.
      delete window.TaskSelectorManager;
      console.log("Task Selector destroyed.");
    },
    selectTasksByBv: (bvId: string, shouldSelect: boolean) => {
      if (!bvId) return;

      console.log(
        `TaskSelectorManager.selectTasksByBv called for BV: ${bvId}, select: ${shouldSelect}`,
      );

      let changed = false;
      let affectsCurrentTab = false;

      // Loop through all tabs to find the parent task(s) associated with the bvId.
      // This is robust in case the same video appears in multiple lists (tabs).
      for (const tabId in allTasksData) {
        const parentTask = allTasksData[tabId].tasks.find(
          (pt) => pt.bv === bvId,
        );

        if (parentTask) {
          // We found a matching parent task. Now process its children.
          parentTask.children.forEach((child) => {
            const childId = child.id;

            if (shouldSelect) {
              // --- SELECT LOGIC ---
              // Only select if it's not already selected AND not already marked.
              if (
                !selectedTaskIds.has(childId) &&
                !markedTaskIds.has(childId)
              ) {
                selectedTaskIds.add(childId);
                changed = true;
              }
            } else {
              // --- DESELECT LOGIC ---
              // Only deselect if it's currently in the selection set.
              if (selectedTaskIds.has(childId)) {
                selectedTaskIds.delete(childId);
                changed = true;
              }
            }
          });

          // If a change occurred, check if it affects the currently visible tab.
          if (changed && tabId === currentTabId) {
            affectsCurrentTab = true;
          }
        }
      }

      // --- UI UPDATE LOGIC ---
      // If any change happened and it affects the current tab, trigger a re-render.
      if (changed && affectsCurrentTab) {
        console.log(
          `TaskSelectorManager: Re-rendering current tab after selection change for BV ${bvId}.`,
        );

        if (
          tabStates[currentTabId!] &&
          !windowState.collapsed &&
          taskListContainer
        ) {
          tabStates[currentTabId!].needsRender = true;
          // Force a full re-render to guarantee all styles are updated correctly.
          tabStates[currentTabId!].lastRenderedScrollTop = -1;
          scheduleTick();
        }
      } else if (changed) {
        // Log for debugging if a change happened in a background tab.
        console.log(
          `TaskSelectorManager: Selection changed for BV ${bvId} in a non-visible tab.`,
        );
      }
    },
  };
  window.TaskSelectorManager = TaskSelectorManager;

  // --- Initialize ---
  function attemptInit() {
    if (document.body && document.readyState !== "loading") {
      init();
    } else if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    } else {
      // Fallback for unusual scenarios
      setTimeout(attemptInit, 50);
    }
  }
  attemptInit();
}

function BiliSelectScript(initialMediaId: string, window: CustomWindow): void {
  "use strict";

  const LOG_PREFIX = "[BiliSelectScript V3]";
  const VIDEO_CARD_SELECTOR = ".bili-video-card__wrap";
  const LINK_SELECTOR = "a.bili-cover-card, .bili-video-card__title a";
  const SELECTED_CLASS = "custom-card-selected-highlight-v3";
  const SELECTION_RECT_ID = "custom-selection-rectangle-v3";
  const DRAG_THRESHOLD = 5;
  const API_URL_PATTERN = /api\.bilibili\.com\/x\/v3\/fav\/resource\/list/;
  const EVENT_SCOPE_SELECTOR = ".fav-list-main";
  const VIDEO_LIST_CONTAINER_SELECTOR = ".fav-list-main";

  console.log(
    `${LOG_PREFIX} Detected favlist page. Initial media_id (fid): ${initialMediaId}. Initializing script.`,
  );

  // 在 BiliSelectScript 函数作用域内
  const BiliSelectScriptAPI: BiliSelectScriptAPI_Interface = {
    selectVideoCardByBv: (
      bvId: string,
      shouldSelect: boolean,
      originatingFromTaskManager: boolean = false,
      originMediaId: string | null = null,
    ): void => {
      log(
        `BiliSelectScriptAPI.selectVideoCardByBv called for BV: ${bvId}, select: ${shouldSelect}, fromTaskMgr: ${originatingFromTaskManager}`,
      );
      // 确保操作的是当前 media_id 的 selection 数组
      if (!selectionStorage[currentMediaId]) {
        selectionStorage[currentMediaId] = [];
      }
      currentSelection = selectionStorage[currentMediaId]; // 重新确认

      const container = findVideoListContainer(); // 确保获取到正确的容器
      if (!container) {
        log(
          "BiliSelectScriptAPI: Video list container not found for style update.",
        );
        // 即使容器找不到，我们仍然需要更新 currentSelection 存储
        const indexInCurrent = currentSelection.indexOf(bvId);
        if (shouldSelect && indexInCurrent === -1) {
          currentSelection.push(bvId);
        } else if (!shouldSelect && indexInCurrent > -1) {
          currentSelection.splice(indexInCurrent, 1);
        }
        logState(
          `BiliSelectScriptAPI: BV ${bvId} selection state updated in storage (no DOM container).`,
        );
        return;
      }

      let cardStateChangedInStorage = false;
      const index = currentSelection.indexOf(bvId);

      if (shouldSelect) {
        if (index === -1) {
          currentSelection.push(bvId);
          cardStateChangedInStorage = true;
        }
      } else {
        // shouldSelect is false
        if (index > -1) {
          currentSelection.splice(index, 1);
          // cardStateChangedInStorage = true;
        } else {
          const originSelection = selectionStorage[originMediaId!];
          originSelection?.splice(originSelection.indexOf(bvId), 1);
        }
        cardStateChangedInStorage = true;
      }

      if (cardStateChangedInStorage) {
        logState(
          `BiliSelectScriptAPI: BV ${bvId} selection updated in storage to ${shouldSelect}.`,
        );
      }

      // 现在更新 DOM 中所有匹配的卡片
      const cards =
        container.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR);
      let visualChangeMade = false;
      cards.forEach((card) => {
        const cardBvId = getBvId(card);
        if (cardBvId === bvId) {
          if (shouldSelect) {
            if (!card.classList.contains(SELECTED_CLASS)) {
              addSelectedStyle(card);
              visualChangeMade = true;
            }
          } else {
            // shouldSelect is false
            if (card.classList.contains(SELECTED_CLASS)) {
              removeSelectedStyle(card);
              visualChangeMade = true;
            }
          }
        }
      });
      if (visualChangeMade) {
        log(
          `BiliSelectScriptAPI: Visual style for BV ${bvId} updated on page.`,
        );
      }
      // 如果存储状态改变了但视觉上没有改变（例如卡片还未加载），applySelectionStylesToPage 之后会处理
      if (cardStateChangedInStorage && !visualChangeMade && !shouldSelect) {
        log(
          `BiliSelectScriptAPI: BV ${bvId} was deselected in storage, but no matching card found in current DOM to remove style. Style will be handled by observer/applySelectionStylesToPage if card loads later.`,
        );
      }
    },
    isBvSelected: (bvId: string): boolean => {
      // 确保检查的是当前 media_id 的 selection
      return selectionStorage[currentMediaId]
        ? selectionStorage[currentMediaId].includes(bvId)
        : false;
    },
  };
  window.BiliSelectScriptAPI = BiliSelectScriptAPI;

  let selectionStorage: Record<string, string[]> = {};
  let currentMediaId: string = initialMediaId;
  let currentSelection: string[]; // Will point to selectionStorage[currentMediaId]

  if (!selectionStorage[currentMediaId]) {
    selectionStorage[currentMediaId] = [];
  }
  currentSelection = selectionStorage[currentMediaId];

  let isDragging = false;
  let startX = 0,
    startY = 0;
  let endX = 0,
    endY = 0;
  let didDrag = false;
  let selectionRectElement: HTMLDivElement | null = null;
  let videoListContainer: HTMLElement | null = null;

  function log(...args: any[]): void {
    console.log(LOG_PREFIX, ...args);
  }

  function logState(message: string = ""): void {
    if (message) log(message);
    log(`Current Media ID: ${currentMediaId}`);
    const selectionPreview =
      currentSelection.length > 10
        ? [
            ...currentSelection.slice(0, 10),
            `... (${currentSelection.length - 10} more)`,
          ]
        : [...currentSelection];
    log(
      `Current Selection (${currentSelection.length} items):`,
      selectionPreview,
    );
  }

  function getBvId(element: HTMLElement | null): string | null {
    if (!element) return null;
    const cardRoot = element.closest<HTMLElement>(VIDEO_CARD_SELECTOR);
    if (!cardRoot) return null;
    const linkElement =
      cardRoot.querySelector<HTMLAnchorElement>(LINK_SELECTOR);
    if (linkElement && linkElement.href) {
      const match = linkElement.href.match(/BV([a-zA-Z0-9]+)/);
      return match ? match[0] : null;
    }
    return null;
  }

  function addSelectedStyle(element: HTMLElement | null): void {
    if (element) element.classList.add(SELECTED_CLASS);
  }
  function removeSelectedStyle(element: HTMLElement | null): void {
    if (element) element.classList.remove(SELECTED_CLASS);
  }

  function toggleSelection(element: HTMLElement): void {
    const bvId = getBvId(element);
    if (!bvId || !currentMediaId) return;

    if (!selectionStorage[currentMediaId]) {
      log(`Error: Selection array for ${currentMediaId} missing. Recreating.`);
      selectionStorage[currentMediaId] = [];
    }
    currentSelection = selectionStorage[currentMediaId]; // Ensure pointer is correct

    const index = currentSelection.indexOf(bvId);
    let isNowSelected: boolean;

    if (index > -1) {
      // Deselecting in BiliSelectScript
      currentSelection.splice(index, 1);
      removeSelectedStyle(element);
      isNowSelected = false;
      logState(`Deselected: ${bvId} (user action)`);
    } else {
      // Selecting in BiliSelectScript
      currentSelection.push(bvId);
      addSelectedStyle(element);
      isNowSelected = true;
      logState(`Selected: ${bvId} (user action)`);
      // 确保任务已添加到 TaskManager
      // addSingleVideo 应该能处理重复添加（不重复添加任务，但可能重复获取分页）
      // 或者 TaskManager.addTaskData 本身就是幂等的
      if (window.TaskSelectorManager) {
        const folderName =
          window.folders?.get(currentMediaId) || "Unknown Folder";
        // Pass true for the new parameter
        addSingleVideo(String(currentMediaId), folderName, bvId!, window, true);
      }
    }

    // Sync selection state with TaskManager
    if (window.TaskSelectorManager) {
      console.log(
        `BiliSelect.toggleSelection: Calling TaskManager.selectTasksByBv for ${bvId}, select: ${isNowSelected}`,
      );
      window.TaskSelectorManager.selectTasksByBv(bvId, isNowSelected, true);
    }
  }

  function updateSelectionRect(): void {
    if (!selectionRectElement) {
      selectionRectElement = document.createElement("div");
      selectionRectElement.id = SELECTION_RECT_ID;
      document.body.appendChild(selectionRectElement);
    }
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    selectionRectElement.style.left = `${x}px`;
    selectionRectElement.style.top = `${y}px`;
    selectionRectElement.style.width = `${width}px`;
    selectionRectElement.style.height = `${height}px`;
  }

  function removeSelectionRect(): void {
    if (selectionRectElement) {
      selectionRectElement.remove();
      selectionRectElement = null;
    }
  }

  function isIntersecting(
    element: HTMLElement,
    rectBounds: { left: number; top: number; right: number; bottom: number },
  ): boolean {
    const elemRect = element.getBoundingClientRect();
    return !(
      elemRect.right < rectBounds.left ||
      elemRect.left > rectBounds.right ||
      elemRect.bottom < rectBounds.top ||
      elemRect.top > rectBounds.bottom
    );
  }

  // In BiliSelectScript
  function applySelectionStylesToPage(): void {
    if (!currentMediaId) {
      log("ApplyStyles: No currentMediaId set, skipping.");
      return;
    }
    if (!selectionStorage.hasOwnProperty(currentMediaId)) {
      log(
        `ApplyStyles: No selection array for ${currentMediaId} yet. Creating empty.`,
      );
      selectionStorage[currentMediaId] = [];
    }
    currentSelection = selectionStorage[currentMediaId]; // 关键：始终使用当前 media_id 的选择

    log(
      `ApplyStyles: Applying styles for media_id: ${currentMediaId} (Items stored: ${currentSelection.length})`,
    );
    const container = findVideoListContainer();
    if (!container) {
      log("ApplyStyles: Container not found, cannot apply styles.");
      return;
    }

    const cards = container.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR);
    log(
      `ApplyStyles: Found ${cards.length} cards in container to check for media_id ${currentMediaId}.`,
    );
    let styledCount = 0;
    cards.forEach((card) => {
      const bvId = getBvId(card);
      if (bvId) {
        if (currentSelection.includes(bvId)) {
          addSelectedStyle(card);
          styledCount++;
        } else {
          removeSelectedStyle(card); // 确保未选中的没有样式
        }
      } else {
        removeSelectedStyle(card); // 如果找不到 BV ID，也移除样式
      }
    });
    log(
      `ApplyStyles: Style application complete for ${currentMediaId}. ${styledCount} items styled as selected.`,
    );
  }

  function findVideoListContainer(): HTMLElement | null {
    if (!videoListContainer || !document.body.contains(videoListContainer)) {
      videoListContainer = document.querySelector<HTMLElement>(
        VIDEO_LIST_CONTAINER_SELECTOR,
      );
    }
    return videoListContainer;
  }

  function handleMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest(EVENT_SCOPE_SELECTOR)) return;

    if (
      event.button !== 0 ||
      target.closest(
        "a, button, input, .bili-card-dropdown, .bili-card-checkbox, .bili-card-watch-later",
      )
    )
      return;

    isDragging = true;
    didDrag = false;
    startX = event.clientX;
    startY = event.clientY;
    endX = event.clientX;
    endY = event.clientY;

    document.body.style.userSelect = "none";
    document.body.classList.add("custom-dragging-v3");
  }

  function handleMouseMove(event: MouseEvent): void {
    if (!isDragging) return;

    endX = event.clientX;
    endY = event.clientY;

    if (
      !didDrag &&
      (Math.abs(endX - startX) > DRAG_THRESHOLD ||
        Math.abs(endY - startY) > DRAG_THRESHOLD)
    ) {
      didDrag = true;
      log("Drag started (threshold crossed)");
    }

    if (didDrag) {
      event.preventDefault();
      updateSelectionRect();
    }
  }

  function handleMouseUp(event: MouseEvent): void {
    void event;
    if (!isDragging) return;
    isDragging = false;

    document.body.style.userSelect = "";
    document.body.classList.remove("custom-dragging-v3");

    if (didDrag) {
      log("Drag ended");
      removeSelectionRect();
      const rectBounds = {
        left: Math.min(startX, endX),
        top: Math.min(startY, endY),
        right: Math.max(startX, endX),
        bottom: Math.max(startY, endY),
      };

      const container = findVideoListContainer();
      if (!container) {
        log("Error: Cannot find container for drag selection.");
        didDrag = false;
        return;
      }
      const cards =
        container.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR);
      log(`DragSelect: Checking ${cards.length} cards...`);
      let changedCount = 0;
      cards.forEach((card) => {
        if (isIntersecting(card, rectBounds)) {
          toggleSelection(card);
          changedCount++;
        }
      });
      if (changedCount > 0)
        logState(`Selection updated via drag (${changedCount} toggled)`);
      else log("DragSelect: No items intersected.");
    }
    didDrag = false;
  }

  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest(EVENT_SCOPE_SELECTOR)) return;
    if (didDrag) return; // Was a drag, not a click

    const targetCard = target.closest<HTMLElement>(VIDEO_CARD_SELECTOR);
    if (!targetCard) return;

    if (
      target.closest(
        "a, button, input, .bili-card-dropdown, .bili-card-checkbox, .bili-card-watch-later",
      )
    )
      return;

    toggleSelection(targetCard);
  }

  const originalFetch = window.fetch;
  window.fetch = async (
    ...args: [RequestInfo | URL, RequestInit?]
  ): Promise<Response> => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const method =
      args[0] instanceof Request ? args[0].method : args[1]?.method || "GET";

    log(`Fetch detected: ${method} ${url}`);

    if (url && API_URL_PATTERN.test(url)) {
      log(`FETCH: Detected target API call: ${url}`);
      try {
        const urlParams = new URLSearchParams(url.split("?")[1]);
        const fetchMediaId = urlParams.get("media_id");
        const fetchPn = urlParams.get("pn");

        if (fetchMediaId && fetchMediaId !== currentMediaId) {
          log(
            `FETCH: Media ID changing from ${currentMediaId} to ${fetchMediaId}. Updating state...`,
          );
          currentMediaId = fetchMediaId;
          if (!selectionStorage.hasOwnProperty(currentMediaId)) {
            log(
              `FETCH: Creating new empty selection array for new media_id: ${currentMediaId}`,
            );
            selectionStorage[currentMediaId] = [];
          } else {
            log(
              `FETCH: Switching to existing selection array for media_id: ${currentMediaId}`,
            );
          }
          currentSelection = selectionStorage[currentMediaId];
          logState(
            `FETCH: Switched active context to media_id ${currentMediaId}`,
          );
          requestAnimationFrame(applySelectionStylesToPage);
        } else if (fetchMediaId && fetchMediaId === currentMediaId) {
          log(
            `FETCH: Media ID ${currentMediaId} same (pn=${fetchPn}). State persists.`,
          );
        } else {
          log("FETCH: Target API call, but media_id missing or unexpected.");
        }
      } catch (error: any) {
        log("FETCH: Error parsing fetch URL parameters:", error.message);
      }
    }

    // responsePromise is the Promise returned by the fetch call. It will eventually
    // resolve with a Response object or reject with an error.
    const responsePromise: Promise<Response> = originalFetch.apply(
      this,
      args as any,
    );

    responsePromise
      .then((response: Response) => {
        // 'response' is the object that the Promise successfully resolves with.
        // It is of the built-in 'Response' type, which contains information like
        // status codes, headers, and the response body.
        return response;
      })
      .catch((error: any) => {
        // 'error' is the value passed to the rejection handler if the Promise fails.
        // Its type is typically 'any' or 'unknown' because any kind of value can be
        // thrown as an error (event.g., an Error object, a string, etc.).
        // A network failure during a fetch call often results in a TypeError.
        log(
          `FETCH: Error during fetch for ${url.substring(0, 100)}... :`,
          error,
        );
        throw error; // Re-throwing the error is important to propagate the failure.
      });

    return responsePromise;
  };

  const observerCallback: MutationCallback = (mutationsList, observer) => {
    void observer;
    let relevantChangeDetected = false;
    for (const mutation of mutationsList) {
      if (mutation.type === "childList") {
        const checkNodes = (nodes: NodeList): boolean => {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              ((node as HTMLElement).matches(VIDEO_CARD_SELECTOR) ||
                (node as HTMLElement).querySelector(VIDEO_CARD_SELECTOR))
            ) {
              return true;
            }
          }
          return false;
        };
        if (
          checkNodes(mutation.addedNodes) ||
          checkNodes(mutation.removedNodes)
        ) {
          relevantChangeDetected = true;
          break;
        }
      }
    }

    if (relevantChangeDetected) {
      log("Observer: Relevant DOM change detected. Re-applying styles...");
      requestAnimationFrame(applySelectionStylesToPage);
    }
  };

  const observer = new MutationObserver(observerCallback);
  const observerConfig: MutationObserverInit = {
    childList: true,
    subtree: true,
  };

  function startObserver(): void {
    const targetNode = findVideoListContainer();
    if (targetNode) {
      log(`Observer: Starting observer on:`, targetNode);
      try {
        observer.disconnect();
        observer.observe(targetNode, observerConfig);
      } catch (error: any) {
        log("Observer: Error starting:", error.message);
      }
    } else {
      log("Observer: Container not found. Retrying observer setup in 1s...");
      setTimeout(startObserver, 1000);
    }
  }

  function injectStylesBiliSelect(): void {
    const css = `
            .${SELECTED_CLASS} {
                outline: 3px solid #00a1d6 !important;
                box-shadow: 0 0 10px rgba(0, 161, 214, 0.8) !important;
                border-radius: 6px;
                transform: translateZ(0);
                background-color: rgba(0, 161, 214, 0.03);
            }
            #${SELECTION_RECT_ID} {
                position: fixed;
                border: 1px dashed #00a1d6;
                background-color: rgba(0, 161, 214, 0.15);
                z-index: 9999;
                pointer-events: none;
            }
            body.custom-dragging-v3 {
                user-select: none !important;
                -webkit-user-select: none !important;
                -moz-user-select: none !important;
                -ms-user-select: none !important;
            }
        `;
    const styleId = "bili-select-script-styles-v3";
    let existingStyle = document.getElementById(styleId);
    if (existingStyle) existingStyle.remove();

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
    log("Injected custom styles for BiliSelectScript.");
  }

  window.showBiliSelections = (mediaId: string | null = null): void => {
    console.log(`${LOG_PREFIX} --- Inspecting Selection Storage ---`);
    if (mediaId) {
      if (selectionStorage.hasOwnProperty(mediaId)) {
        console.log(
          `Selections for media_id "${mediaId}" (${selectionStorage[mediaId].length} items):`,
        );
        if (selectionStorage[mediaId].length > 0) {
          console.table(selectionStorage[mediaId].map((bv) => ({ BV_ID: bv })));
        } else {
          console.log("(This list is currently empty)");
        }
      } else {
        console.log(`No selection data found for media_id: ${mediaId}`);
        console.log(
          `Currently tracked media_ids:`,
          Object.keys(selectionStorage),
        );
      }
    } else {
      const trackedIds = Object.keys(selectionStorage);
      if (trackedIds.length === 0) {
        console.log("No selections have been tracked yet.");
      } else {
        console.log("All tracked selections by media_id:");
        console.log(JSON.parse(JSON.stringify(selectionStorage)));
        const tableData: Record<string, { Count: number; Preview: string }> =
          {};
        for (const id in selectionStorage) {
          if (selectionStorage.hasOwnProperty(id)) {
            const selectionArray = selectionStorage[id];
            const count = selectionArray.length;
            const preview = selectionArray.slice(0, 5).join(", ");
            tableData[id] = {
              Count: count,
              Preview: count > 5 ? `${preview}...` : preview || "(empty)",
            };
          }
        }
        console.log("Summary view:");
        console.table(tableData);
      }
    }
    console.log(`${LOG_PREFIX} --- End Inspection ---`);
  };

  window.removeBiliSelections = (
    mediaId: string,
    bvIdsToRemove: string[],
  ): void => {
    console.log(`${LOG_PREFIX} --- Attempting Batch Removal ---`);
    if (typeof mediaId !== "string" || !mediaId) {
      console.error(`${LOG_PREFIX} Invalid media_id provided.`);
      console.log(`${LOG_PREFIX} --- Removal Failed ---`);
      return;
    }
    if (!Array.isArray(bvIdsToRemove)) {
      console.error(
        `${LOG_PREFIX} Invalid bvIdsToRemove provided (must be an array).`,
      );
      console.log(`${LOG_PREFIX} --- Removal Failed ---`);
      return;
    }
    if (bvIdsToRemove.length === 0) {
      log(`No BV IDs provided for removal from media_id ${mediaId}.`);
      console.log(`${LOG_PREFIX} --- Removal Complete (No Action) ---`);
      return;
    }
    if (!selectionStorage.hasOwnProperty(mediaId)) {
      log(`Media ID "${mediaId}" not found in storage.`);
      console.log(`${LOG_PREFIX} --- Removal Failed ---`);
      return;
    }

    const initialCount = selectionStorage[mediaId].length;
    log(
      `Removing items from media_id "${mediaId}". Initial: ${initialCount}. Removing:`,
      bvIdsToRemove,
    );
    selectionStorage[mediaId] = selectionStorage[mediaId].filter(
      (bv) => !bvIdsToRemove.includes(bv),
    );
    const finalCount = selectionStorage[mediaId].length;
    const removedCount = initialCount - finalCount;
    log(
      `Removal complete. ${removedCount} item(s) removed. Final count: ${finalCount}.`,
    );

    if (mediaId === currentMediaId) {
      log("Updating page visuals as the current list was modified.");
      requestAnimationFrame(applySelectionStylesToPage);
      logState("State updated after batch removal");
    } else {
      log(
        `(Visuals not updated as media_id "${mediaId}" is not current: "${currentMediaId}")`,
      );
    }
    console.log(`${LOG_PREFIX} --- Removal Complete ---`);
  };

  function runInitialization(): void {
    injectStylesBiliSelect();
    document.addEventListener("mousedown", handleMouseDown, false);
    document.addEventListener("mousemove", handleMouseMove, false);
    document.addEventListener("mouseup", handleMouseUp, false);
    document.addEventListener("click", handleClick, true); // Use capture for click to potentially override other listeners

    startObserver();
    requestAnimationFrame(applySelectionStylesToPage);

    logState("Initial state after page load for BiliSelectScript");
    log(
      'API functions "showBiliSelections(mediaId?)" and "removeBiliSelections(mediaId, bvIdArray)" are available.',
    );
    log("BiliSelectScript initialization complete.");

    // Initial sync: After BiliSelectScript has established its selections (event.g. from cache or default)
    // Tell TaskManager about BiliSelect's current selections for the active media_id
    if (
      window.TaskSelectorManager &&
      currentSelection &&
      currentSelection.length > 0
    ) {
      log(
        `BiliSelect init: Performing initial sync with TaskManager for ${currentSelection.length} selected BVs.`,
      );
      currentSelection.forEach((selectedBvId) => {
        // Ensure tasks for this BV are loaded in TaskManager first
        const folderName =
          window.folders?.get(currentMediaId) || "Unknown Folder";
        // Pass true here as well, these are selected in BiliSelect
        addSingleVideo(
          String(currentMediaId),
          folderName,
          selectedBvId,
          window,
          true,
        );
        window.TaskSelectorManager!.selectTasksByBv(selectedBvId, true, true);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runInitialization);
  } else {
    runInitialization();
  }
}

// Global scope or where BiliSelectScript can call it

async function addSingleVideo(
  tabId: string, // media_id from BiliSelectScript
  tabName: string, // folder name from BiliSelectScript
  bvId: string,
  window: CustomWindow,
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

    if (window.TaskSelectorManager) {
      const parentTaskInput = {
        videoTitle: videoTitle,
        bvId: bvId,
        pages: pages,
      };
      window.TaskSelectorManager.addTaskData(
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
// CSS Selectors
const CONTAINER_SELECTOR = "div.video-pod__list.section";
const ITEM_SELECTOR = "div.pod-item.video-pod__item.simple";

/**
 * 检查并提取【第一个】匹配容器元素下的 data-key 属性。
 * Checks for the first container and extracts data-key attributes from its matching descendant items.
 *
 * @param {Document | Element} rootNode - The node to start searching from (e.g., document or a specific element). Defaults to browser's `document`.
 * @returns {string[]} An array of data-key strings, or an empty array if the container or items are not found, or items lack the attribute.
 */
function extractKeysFromFirstContainer(
  rootNode: Document | Element = document,
): string[] {
  console.log(`\n--- 正在查找第一个容器: '${CONTAINER_SELECTOR}' ---`);

  // 1. 查找第一个容器. 使用 <HTMLDivElement> 明确类型，返回值可能是 HTMLDivElement 或 null
  const containerDiv: HTMLDivElement | null =
    rootNode.querySelector<HTMLDivElement>(CONTAINER_SELECTOR);

  // 2. 判断容器是否存在 (TypeScript 严格空检查会要求必须处理 null)
  if (!containerDiv) {
    console.warn(`❌ 未找到容器元素: '${CONTAINER_SELECTOR}'`);
    return [];
  }

  console.log(`✅ 已找到第一个容器元素。`);

  // 3. 从容器内部查找所有匹配的子元素, 返回 NodeListOf<HTMLDivElement>
  const itemDivs: NodeListOf<HTMLDivElement> =
    containerDiv.querySelectorAll<HTMLDivElement>(ITEM_SELECTOR);

  if (itemDivs.length === 0) {
    console.log(`ℹ️  容器内未找到符合条件的子元素: '${ITEM_SELECTOR}'`);
    return [];
  }
  console.log(
    `✅ 在容器内找到 ${itemDivs.length} 个符合选择器 '${ITEM_SELECTOR}' 的子元素。`,
  );

  // 4. 提取 data-key
  const dataKeys = Array.from(itemDivs)
    // getAttribute 返回 string | null
    // dataset.key 返回 string | undefined (dataset 属性只在 HTMLElement 上明确存在)
    .map((item) => item.getAttribute("data-key"))
    // 关键: 使用 Type Guard (类型守卫: key is string)
    // 告诉 TypeScript 过滤后，数组里只剩下 string, 不再包含 null
    .filter((key): key is string => key !== null);

  // 或者使用 flatMap (更简洁):
  /*
       const dataKeys = Array.from(itemDivs).flatMap(item => {
           const key = item.getAttribute('data-key');
            // 如果 key 是 null, 返回 [], flatMap 会自动忽略它；否则返回包含 key 的数组 [key]
           return key === null ? [] : [key];
       });
      */
  console.log(`✅ 成功提取 ${dataKeys.length} 个 data-key。`);
  return dataKeys;
}

(async (unsafeWin: CustomWindow) => {
  // Type unsafeWin as CustomWindow directly
  "use strict";
  const LOG_PREFIX_MAIN = "[BiliBiliDownload Main]";
  const FAVLIST_URL_PATTERN =
    /space\.bilibili\.com\/([0-9]+)\/favlist\?fid=([0-9]+)/;
  const VIDEO_PATTERN =
    /^https:\/\/www\.bilibili\.com\/video\/BV([a-zA-Z0-9]+)\/?.*?$/;

  const url = unsafeWin.location.href;
  const MatchFavlist = url.match(FAVLIST_URL_PATTERN);
  const MatchVideo = url.match(VIDEO_PATTERN);

  console.log(`${LOG_PREFIX_MAIN} URL: ${url}`);
  console.log(`${LOG_PREFIX_MAIN} Favlist Match:`, MatchFavlist);
  console.log(`${LOG_PREFIX_MAIN} Video Match:`, MatchVideo);

  // Initialize the Task Selector UI first, so other scripts can interact with it.
  TaskSelectScript(unsafeWin);

  if (MatchFavlist && MatchFavlist[1] && MatchFavlist[2]) {
    unsafeWin.folders = new Map<string, string>();
    const upMid = MatchFavlist[1];
    const fid = MatchFavlist[2];
    console.log(`${LOG_PREFIX_MAIN} Fetching folders for up_mid: ${upMid}`);

    try {
      // Use GM_xmlhttpRequest to fetch the folder list

      const json = await gmFetch<any>({
        method: "GET",
        url: `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${upMid}`,
        responseType: "json", // Let GM handle JSON parsing
        headers: {
          Referer: `https://space.bilibili.com/${upMid}/favlist`,
        },
      });

      if (json && json.data && json.data.list) {
        json.data.list.forEach((folder: any) => {
          unsafeWin.folders!.set(String(folder.id), String(folder.title));
        });
        console.log(`${LOG_PREFIX_MAIN} Folders loaded:`, unsafeWin.folders);
      } else {
        console.error(
          `${LOG_PREFIX_MAIN} Unexpected folder API response format:`,
          json,
        );
      }
    } catch (error) {
      console.error(`${LOG_PREFIX_MAIN} Failed to fetch folders:`, error);
    }

    // Initialize the BiliSelect script after getting the folders
    BiliSelectScript(fid, unsafeWin);
  } else if (MatchVideo && MatchVideo[1]) {
    let bvId = MatchVideo[1]; // The BV ID from the URL path
    if (!bvId) {
      const bvQueryMatch = url.match(/(?<=bvid=)[a-zA-Z0-9]+/);
      if (bvQueryMatch && bvQueryMatch[0]) {
        bvId = bvQueryMatch[0];
      }
    }

    if (bvId) {
      console.log(`${LOG_PREFIX_MAIN} Video page detected, BV: ${bvId}`);
      // Add the video to a default tab in the Task Selector
      extractKeysFromFirstContainer(unsafeWin.document).forEach((ele) => {
        addSingleVideo("default", "视频页", ele, unsafeWin);
      });
      addSingleVideo("default", "视频页", bvId, unsafeWin);
    } else {
      console.log(
        `${LOG_PREFIX_MAIN} Video page detected, but could not extract BV ID.`,
      );
    }
  } else {
    console.log(
      `${LOG_PREFIX_MAIN} Not on a matching favlist or video page. Script is idle.`,
    );
  }
})(unsafeWindow as CustomWindow);
