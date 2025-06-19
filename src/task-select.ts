import { CustomWindow, TaskSelectorManagerAPI } from "./types";
import { deleteChunk, getChunk, saveChunk } from "./db";

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

// Define the structure for our flattened list
interface FlatTaskItem {
  type: "parent" | "child";
  data: ParentTask | Task;
  parent?: ParentTask; // For child tasks
  top: number;
  height: number;
}

interface TabState {
  taskScrollTop: number;
  tabScrollLeft: number;
  needsRender: boolean;
  lastRenderedScrollTop: number;
  // ADD THIS
  flatListCache?: FlatTaskItem[];
  // ADD THIS
  needsCacheUpdate?: boolean;
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

export function TaskSelectScript(window: CustomWindow): void {
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

  // --- 新增/修改用于框选和滚动的变量 ---
  let lastClientX = 0;
  let lastClientY = 0;
  let autoScrollDirection = 0;
  const AUTO_SCROLL_ZONE_SIZE = 40;
  const AUTO_SCROLL_SPEED_MAX = 8;
  // --- 【新增】用于锚定坐标系的状态变量 ---
  let startScrollTop = 0;
  let startContainerRect: DOMRect | null = null;
  // --- 结束新增 ---

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
  // --- 工具函数 ---
  // ... (debounce, createDragHandler 等函数)
  /**
   * 根据已存储的起始点和最新的鼠标坐标，更新选择框的视觉位置和尺寸。
   * 这个函数是更新选择框样式的唯一来源，并正确处理滚动带来的坐标转换。
   */
  function updateSelectionBoxVisuals(): void {
    if (!selectionBoxElement || !taskListContainer || !startContainerRect)
      return;

    // 1. 计算“锚点”（鼠标按下的点）在可滚动容器内部的固定坐标。
    // 这个坐标在整个拖拽过程中是不会改变的。
    // (鼠标起始Y - 容器起始top) = 鼠标在容器视区内的偏移 + 容器起始的滚动距离
    const anchorYInContainer =
      selectionBoxStart.y - startContainerRect.top + startScrollTop;
    // 水平方向同理 (为简化，假设无水平滚动)
    const anchorXInContainer = selectionBoxStart.x - startContainerRect.left;

    // 2. 计算“活动点”（鼠标当前的位置）在可滚动容器内部的实时坐标。
    // 这个坐标会随着列表滚动和鼠标移动而实时变化。
    const currentContainerRect = taskListContainer.getBoundingClientRect();
    const activeYInContainer =
      lastClientY - currentContainerRect.top + taskListContainer.scrollTop;
    const activeXInContainer = lastClientX - currentContainerRect.left;

    // 3. 根据“锚点”和“活动点”这两个在同一坐标系下的点，确定选择框的最终样式。
    const finalTop = Math.min(anchorYInContainer, activeYInContainer);
    const finalLeft = Math.min(anchorXInContainer, activeXInContainer);
    const finalHeight = Math.abs(anchorYInContainer - activeYInContainer);
    const finalWidth = Math.abs(anchorXInContainer - activeXInContainer);

    // 4. 应用样式
    Object.assign(selectionBoxElement.style, {
      top: `${finalTop}px`,
      left: `${finalLeft}px`,
      height: `${finalHeight}px`,
      width: `${finalWidth}px`,
    });
  }

  /**
   * 主视觉循环，在鼠标按下和松开之间持续运行。
   * 负责处理自动滚动和选择框的重绘。
   */
  function tickSelectionBox(): void {
    // 如果鼠标已松开，则立即停止循环
    if (!isSelectingBox) return;

    // 1. 如果需要，执行自动滚动 (这会改变 scrollTop)
    if (autoScrollDirection !== 0 && taskListContainer) {
      taskListContainer.scrollTop +=
        AUTO_SCROLL_SPEED_MAX * autoScrollDirection;
    }

    // 2. 【关键】在每次循环（包括滚动后），都调用绘制函数来重绘选择框。
    //    updateSelectionBoxVisuals 内部已经处理了坐标转换。
    updateSelectionBoxVisuals();

    // 3. 根据重绘后的选择框，更新任务的“预览”高亮状态
    updateSelectionFromBox(false);

    // 4. 请求下一帧，以平滑地继续循环
    requestAnimationFrame(tickSelectionBox);
  }
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
      .task-progress-list-container { flex-grow: 1;
          overflow-y: auto;
          padding: 8px 0; /* 修改: 上下增加一点内边距，左右移除 */
          scrollbar-width: none;
          -ms-overflow-style: none;
          position: relative;}
      .task-progress-list-container::-webkit-scrollbar { display: none; }
      .task-progress-item {
          padding: 5px 8px; /* 左右内边距在这里控制 */
          border: 1px solid #eee;
          border-radius: 3px;
          background-color: #f9f9f9;
          display: flex;
          flex-direction: column;

          /* --- 新的虚拟化样式 --- */
          position: absolute;
          left: 8px; /* 与容器左右内边距匹配 */
          right: 8px;
          height: ${PROGRESS_ITEM_HEIGHT}px; /* 固定高度 */
          box-sizing: border-box; /* 关键！*/
          /* top 属性将由 JS 设置 */
      }
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
      tabStates[currentTabId].needsCacheUpdate = true;
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
    if (state.needsCacheUpdate || !state.flatListCache) {
      console.log(`[Perf] Updating flat list cache for tab: ${currentTabId}`);
      const flatItems: FlatTaskItem[] = [];
      let currentY = 5;
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
      state.flatListCache = flatItems; // Store in cache
      state.needsCacheUpdate = false; // Reset flag
    }

    const flatItems = state.flatListCache!;
    const totalHeight =
      flatItems.length > 0
        ? flatItems[flatItems.length - 1].top +
          flatItems[flatItems.length - 1].height +
          5
        : 10;

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
    const existingItems = taskListContainer.querySelectorAll(
      ".task-selector-task-item",
    );
    existingItems.forEach((item) => item.remove());
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
   * Handles the browser's 'online' event. Finds all failed tasks within each
   * progress window and restarts the download process for them in place.
   */
  async function handleConnectionRestored(): Promise<void> {
    console.log(
      "[Network] Connection restored. Checking for failed downloads to restart.",
    );

    let totalRestartedCount = 0;

    // 遍历每一个独立的进度窗口
    for (const windowId in progressWindows) {
      const pwData = progressWindows[windowId];
      if (!pwData) continue;

      // 1. 找出当前窗口中所有失败的任务
      const tasksToRestartInWindow = pwData.tasks.filter(
        (t) => t.status === "failed",
      );

      // 如果这个窗口里没有失败的任务，就跳过
      if (tasksToRestartInWindow.length === 0) {
        continue;
      }

      console.log(
        `[Network] Found ${tasksToRestartInWindow.length} failed tasks in window ${windowId}. Preparing to restart in place.`,
      );
      totalRestartedCount += tasksToRestartInWindow.length;

      // 2. 准备一个只包含这些失败任务的下载对象
      const tasksForDownload: Record<string, SelectedTask> = {};
      tasksToRestartInWindow.forEach((task) => {
        // 关键：立即更新UI，将任务状态重置为“等待中”，给用户即时反馈
        updateTaskStateById(windowId, task.id, {
          status: "pending",
          progress: 0,
        });

        // 将任务添加到待下载的集合中
        tasksForDownload[task.id] = {
          id: task.id,
          name: task.name,
          bv: task.bv,
          marked: true, // 内部状态，设为true即可
        };
      });

      // 3. 直接调用核心 download 函数，但传入的是当前窗口ID和仅失败的任务
      // 我们不需要等待它完成(no await)，让它在后台运行即可
      // 添加 .catch 以防止一个窗口的重启失败影响到其他窗口
      download(tasksForDownload, windowId).catch((error) => {
        console.error(
          `[Network] A critical error occurred while restarting tasks for window ${windowId}:`,
          error,
        );
        // 如果重启过程本身都失败了，最好把任务状态再次标记为失败
        tasksToRestartInWindow.forEach((task) => {
          updateTaskStateById(windowId, task.id, {
            status: "failed",
            progress: 0,
          });
        });
      });
    } // 结束对所有窗口的遍历

    if (totalRestartedCount > 0) {
      alert(
        `网络已恢复, 已在现有窗口中尝试重新启动 ${totalRestartedCount} 个失败的任务。`,
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

  function handleMouseDownTaskList(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest(".task-selector-task-item")) {
      return;
    }

    const containerRect = taskListContainer?.getBoundingClientRect();
    if (
      !containerRect ||
      !taskListContainer ||
      event.clientX > containerRect.right - 15
    ) {
      return;
    }
    event.preventDefault();

    // 总是创建全新的选择框
    taskListContainer.querySelector(".task-selection-box")?.remove();
    selectionBoxElement = document.createElement("div");
    selectionBoxElement.className = "task-selection-box";
    taskListContainer.appendChild(selectionBoxElement);

    isSelectingBox = true;
    initialSelectedInTabForBoxOp = new Set(selectedTaskIds);
    selectionBoxStart = { x: event.clientX, y: event.clientY };
    lastClientX = event.clientX;
    lastClientY = event.clientY;

    // --- 【关键】捕获初始状态以锚定坐标系 ---
    startScrollTop = taskListContainer.scrollTop;
    startContainerRect = containerRect; // 直接使用上面获取的 containerRect
    // --- 结束关键修改 ---

    Object.assign(selectionBoxElement.style, { display: "block" });

    document.addEventListener("mousemove", handleMouseMoveSelectBox, {
      passive: false,
    });
    document.addEventListener("mouseup", handleMouseUpSelectBox);
    document.body.style.userSelect = "none";

    requestAnimationFrame(tickSelectionBox);
  }

  function handleMouseMoveSelectBox(event: MouseEvent): void {
    if (!isSelectingBox) return;
    event.preventDefault();

    // 1. 仅更新最新的鼠标坐标
    lastClientX = event.clientX;
    lastClientY = event.clientY;

    // 2. 仅更新滚动方向信号
    if (!taskListContainer) return;
    const lr = taskListContainer.getBoundingClientRect();
    let scrollDirection = 0;
    if (lastClientY < lr.top + AUTO_SCROLL_ZONE_SIZE) {
      scrollDirection = -1;
    } else if (lastClientY > lr.bottom - AUTO_SCROLL_ZONE_SIZE) {
      scrollDirection = 1;
    }
    autoScrollDirection = scrollDirection;
  }

  function handleMouseUpSelectBox(): void {
    if (!isSelectingBox) {
      return;
    }

    // 停止主循环和滚动
    isSelectingBox = false;
    autoScrollDirection = 0;

    try {
      // 调用最终提交模式，将预览状态写入核心数据
      updateSelectionFromBox(true);
    } catch (error) {
      console.error(
        "Error during final updateSelectionFromBox in mouseup:",
        error,
      );
    } finally {
      // 彻底清理
      selectionBoxElement?.remove();
      selectionBoxElement = null;
      document.removeEventListener("mousemove", handleMouseMoveSelectBox);
      document.removeEventListener("mouseup", handleMouseUpSelectBox);
      document.body.style.userSelect = "";
      initialSelectedInTabForBoxOp.clear();
      // --- 新增清理 ---
      startContainerRect = null;
      startScrollTop = 0;
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

  function updateSelectionFromBox(isFinal: boolean = false): void {
    if (!selectionBoxElement || !taskListContainer) return;

    const boxRectVP = selectionBoxElement.getBoundingClientRect();
    const childTaskItems = taskListContainer.querySelectorAll<HTMLDivElement>(
      ".task-selector-child-task",
    );
    if (childTaskItems.length === 0 && !isFinal) return; // 拖拽中如果没有item，就没必要继续

    const bvsAffected = new Set<string>();

    if (isFinal) {
      // --- 提交模式 (isFinal = true, 在 mouseup 时调用) ---
      // 遍历所有子任务的 DOM 节点来确定最终选择
      const allRenderedItems =
        taskListContainer.querySelectorAll<HTMLDivElement>(
          ".task-selector-child-task",
        );
      allRenderedItems.forEach((item) => {
        const childTaskId = item.dataset.taskId;
        if (childTaskId) {
          // 如果这个节点当前有 'selected' 类，就确保它在最终的 Set 里
          if (item.classList.contains("selected")) {
            selectedTaskIds.add(childTaskId);
          } else {
            selectedTaskIds.delete(childTaskId);
          }
          if (item.dataset.bv) bvsAffected.add(item.dataset.bv);
        }
      });
    } else {
      // --- 预览模式 (isFinal = false, 在拖拽中持续调用) ---
      // 只操作当前可见元素的 class，提供实时视觉反馈
      childTaskItems.forEach((item) => {
        const itemRectVP = item.getBoundingClientRect();
        const childTaskId = item.dataset.taskId;

        if (!childTaskId || markedTaskIds.has(childTaskId)) return;

        const overlaps = !(
          itemRectVP.right < boxRectVP.left ||
          itemRectVP.left > boxRectVP.right ||
          itemRectVP.bottom < boxRectVP.top ||
          itemRectVP.top > boxRectVP.bottom
        );

        const wasInitiallySelected =
          initialSelectedInTabForBoxOp.has(childTaskId);
        let shouldBeSelectedNow = wasInitiallySelected;
        if (overlaps) {
          shouldBeSelectedNow = !wasInitiallySelected;
        }
        item.classList.toggle("selected", shouldBeSelectedNow);
      });
    }

    if (isFinal) {
      // 在提交数据后，进行一次最终的、权威的重绘
      renderTasksForCurrentTab(true);

      // 并同步BiliSelectScript的状态
      if (window.BiliSelectScriptAPI) {
        bvsAffected.forEach((bvIdToUpdate) => {
          const shouldBeSelectedInBili =
            TaskSelectorManager.isAnyTaskSelectedForBv(bvIdToUpdate);
          window.BiliSelectScriptAPI!.selectVideoCardByBv(
            bvIdToUpdate,
            shouldBeSelectedInBili,
            true,
          );
        });
      }
    }
  }

  // src/task-select.ts

  function handleTaskListScroll(): void {
    // --- START: MODIFICATION ---
    // The check "if (isSelectingBox)" has been removed.
    // The virtual render triggered by scrolling is now allowed during drag-selection.
    // The main selection loop (tickSelectionBox) will handle reapplying the correct
    // "preview" styles to the newly rendered items on the next animation frame.
    // --- END: MODIFICATION ---

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

    download(tasksForDownload, nId).catch((err) => {
      console.error(
        "[ConfirmSelection] The download process encountered a critical failure:",
        err,
      );
      // Optionally, notify the user
      alert("下载过程遭遇严重错误，已中断。详情请查看控制台。");
      // Optionally, close the newly created progress window if it's now useless
      closeProgressWindow(nId);
    });

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
      const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB chunks for better performance
      const taskAbortController = new AbortController();
      const taskAbortSignal = taskAbortController.signal;

      const abortHandler = () => {
        taskAbortController.abort();
      };

      activeDownloads.set(taskId, { abort: abortHandler });

      taskAbortSignal.addEventListener("abort", () => {
        console.log(`[Abort] Aborting all chunks for task: ${task.name}`);
        if (activeDownloads.has(taskId)) {
          activeDownloads.delete(taskId);
        }
      });

      try {
        // --- Step 1: Get Video Info & Total Size ---
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
          DOWNLOAD_RETRY_ATTEMPTS,
          DOWNLOAD_RETRY_DELAY_MS,
        );
        const jsonResponse = JSON.parse(videoInfoText);
        if (jsonResponse.code !== 0)
          throw new Error(jsonResponse.message || "Failed to get video URL");
        const videoUrl = jsonResponse.data.durl[0].url;
        const totalSize = jsonResponse.data.durl[0].size;

        // --- Step 2: Resumable Download Loop ---
        let partialChunk = await getChunk(taskId);
        let startByte = partialChunk ? partialChunk.size : 0;

        // If a previously failed download was complete but not deleted from DB, use it directly.
        if (partialChunk && startByte === totalSize) {
          console.log(
            `[Resume] Using fully downloaded chunk from DB for task: ${task.name}`,
          );
        } else {
          while (startByte < totalSize) {
            if (taskAbortSignal.aborted)
              throw new Error("Download aborted by user.");

            const endByte = Math.min(startByte + CHUNK_SIZE - 1, totalSize - 1);
            console.log(
              `[Download] Task ${task.name}: Requesting bytes ${startByte}-${endByte} of ${totalSize}`,
            );

            const newChunkBlob = await new Promise<Blob>((resolve, reject) => {
              const requestHandle = GM_xmlhttpRequest({
                method: "GET",
                url: videoUrl,
                responseType: "blob",
                headers: {
                  Referer: "https://www.bilibili.com/",
                  Range: `bytes=${startByte}-${endByte}`,
                },
                timeout: 120000, // 2 minutes timeout per chunk
                onload: (response: any) => {
                  if (response.status === 206 || response.status === 200) {
                    resolve(response.response as Blob);
                  } else {
                    reject(
                      new Error(`HTTP Error ${response.status} for chunk`),
                    );
                  }
                },
                onerror: (err: any) =>
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

            const percent = Math.round((startByte / totalSize) * 100);
            updateTaskStateById(wid, taskId, {
              status: "downloading",
              progress: percent,
            });
          }
        }

        // --- Step 3: Finalize ---
        if (partialChunk && partialChunk.size >= totalSize) {
          console.log(`[Download] Task ${task.name} completed successfully.`);
          zip.file(task.name + ".mp4", partialChunk);
          updateTaskStateById(wid, taskId, {
            status: "completed",
            progress: 100,
          });
          await deleteChunk(taskId); // Clean up storage on success
          return `成功: ${task.name}`;
        } else {
          throw new Error("Download loop finished but file is incomplete.");
        }
      } catch (err: any) {
        console.error(
          `[Download] Task ${task.name} failed and will be paused:`,
          err.message,
        );
        // On failure, DO NOT delete the chunk from IndexedDB.
        updateTaskStateById(wid, taskId, { status: "failed", progress: 0 });
        throw err;
      } finally {
        if (activeDownloads.has(taskId)) {
          activeDownloads.delete(taskId);
        }
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

  // In TaskSelectScript, near the button actions
  function processVisibleTasks(
    action: (taskId: string, parentBvId: string) => boolean,
  ): void {
    if (!taskListContainer || windowState.collapsed) return;

    const containerRect = taskListContainer.getBoundingClientRect();
    const childTaskItems = taskListContainer.querySelectorAll<HTMLDivElement>(
      ".task-selector-child-task",
    );

    const affectedBvIds = new Set<string>();
    let changed = false;

    childTaskItems.forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const taskId = item.dataset.taskId;
      const parentBvId = item.dataset.bv;

      if (!taskId || !parentBvId) return;

      const isVisible =
        itemRect.top < containerRect.bottom &&
        itemRect.bottom > containerRect.top;

      if (isVisible) {
        // Execute the provided action and check if it made a change
        if (action(taskId, parentBvId)) {
          changed = true;
          affectedBvIds.add(parentBvId);
        }
      }
    });

    // If any change occurred, re-render the list and sync with BiliSelectScript
    if (changed) {
      renderTasksForCurrentTab(true);
      if (window.BiliSelectScriptAPI) {
        affectedBvIds.forEach((bvId) => {
          const shouldBeSelected =
            TaskSelectorManager.isAnyTaskSelectedForBv(bvId);
          window.BiliSelectScriptAPI!.selectVideoCardByBv(
            bvId,
            shouldBeSelected,
            true,
          );
        });
      }
    }
  }

  function selectVisibleTasks(): void {
    processVisibleTasks((taskId) => {
      if (!selectedTaskIds.has(taskId) && !markedTaskIds.has(taskId)) {
        selectedTaskIds.add(taskId);
        return true; // Return true indicating a change was made
      }
      return false;
    });
    console.log(
      `Selected visible tasks. Total active selections: ${selectedTaskIds.size}`,
    );
  }

  function deselectVisibleTasks(): void {
    processVisibleTasks((taskId) => {
      if (selectedTaskIds.has(taskId)) {
        selectedTaskIds.delete(taskId);
        return true; // Return true indicating a change was made
      }
      return false;
    });
    console.log(
      `Deselected visible tasks. Total active selections: ${selectedTaskIds.size}`,
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

  // 文件: src/task-select.ts

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
    listContainer.innerHTML = ""; // 清空容器

    // --- 主要变化：使用一个 spacer 撑开总高度 ---
    const totalHeight = tasks.length * PROGRESS_ITEM_HEIGHT;
    const spacer = document.createElement("div");
    spacer.style.position = "absolute";
    spacer.style.top = "0";
    spacer.style.left = "0";
    spacer.style.height = `${totalHeight}px`;
    spacer.style.width = "1px";
    spacer.style.zIndex = "-1"; // 把它放在最底层
    fragment.appendChild(spacer);

    // 只渲染可见区域的元素
    for (let i = startIndex; i < endIndex; i++) {
      if (tasks[i]) {
        const t = tasks[i];
        const it = document.createElement("div");
        it.className = "task-progress-item";
        it.dataset.taskId = t.id;
        it.dataset.bv = t.bv;

        // --- 主要变化：通过 style.top 定位 ---
        // 现在 top 是相对于 listContainer 的，因为我们加了 position: relative
        it.style.top = `${i * PROGRESS_ITEM_HEIGHT}px`;

        const nS = document.createElement("div");
        nS.className = "task-progress-item-name";
        nS.textContent = t.name;

        // 添加状态文本 (这部分逻辑是正确的，保持不变)
        if (
          t.status !== "downloading" &&
          t.status !== "pending" &&
          t.status !== "completed"
        ) {
          const statusTextElem = document.createElement("span");
          statusTextElem.className = "task-progress-item-status-text";
          let text = "";
          if (t.status === "retrying") text = " (重试中...)";
          if (t.status === "failed") text = " (下载失败)";
          if (t.status === "restarted") text = " (已在新批次中重启)";
          statusTextElem.textContent = text;
          nS.appendChild(statusTextElem);
        }

        const bC = document.createElement("div");
        bC.className = "task-progress-bar-container";
        const b = document.createElement("div");
        b.className = "task-progress-bar";
        b.classList.add(`status-${t.status}`);
        b.style.width = `${t.progress || 0}%`;

        bC.appendChild(b);
        it.append(nS, bC);
        fragment.appendChild(it);
      }
    }

    listContainer.appendChild(fragment);

    pwState.lastRenderedScrollTop = scrollTop;
    pwState.needsRender = false;

    if (forceUpdate) {
      const forcedScrollTop = pwState.scrollTop ?? 0;
      requestAnimationFrame(() => {
        if (listContainer && progressWindows[wId]) {
          listContainer.scrollTop = forcedScrollTop;
          if (progressWindows[wId]) {
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
          isExpanded: true, // Default to collapsed
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
          tabStates[currentTabId].needsCacheUpdate = true;
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
