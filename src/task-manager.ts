import { CustomWindow, TaskSelectorManagerAPI } from "./types";

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

interface ProgressTaskItem extends SelectedTask {
  progress: number;
  windowId: string;
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
  handleMouseDownDrag: (event: MouseEvent) => void;
  handleMouseMoveDrag: ((event: MouseEvent) => void) | null;
  handleMouseUpDrag: ((event: MouseEvent) => void) | null;
  handleMouseDownResize: (event: MouseEvent) => void;
  handleMouseMoveResize: ((event: MouseEvent) => void) | null;
  handleMouseUpResize: ((event: MouseEvent) => void) | null;
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
  const MAX_CONCURRENT_DOWNLOADS = 4; // <-- ADD THIS. (4 is a safe number)
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
  let selectedTasks: Record<string, SelectedTask> = {};
  let currentTabId: string | null = null;
  let tabStates: Record<string, TabState> = {};
  let windowState: WindowUiState = {
    collapsed: true,
    top: "20px",
    left: "20px",
    width: "350px",
    height: "450px",
  };
  let isDragging = false;
  // --- 核心状态管理 ---
  // ... other state variables
  let dragOffset: { x: number; y: number; width?: number; height?: number } = {
    x: 0,
    y: 0,
  };
  // ... other state variables
  let isResizing = false;
  let resizeHandle: HTMLElement | null = null;
  let isSelectingBox = false;
  let selectionBoxStart = { x: 0, y: 0 };
  let selectionBoxElement: HTMLDivElement | null = null;
  let initialSelectedInTabForBoxOp: Record<string, boolean> = {};
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
  function gmFetchWithRetry<T>(
    details: any, // Tampermonkey's GM.Request is complex, 'any' is pragmatic here
    attempts: number,
    initialDelay: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const tryRequest = (currentAttempt: number) => {
        GM_xmlhttpRequest({
          ...details,
          onload: (response: any) => {
            // Success on 2xx status code
            if (response.status >= 200 && response.status < 300) {
              resolve(response.response as T);
            } else {
              // Any other status code is considered a failure for this attempt
              console.warn(
                `[GM_Retry] Attempt ${currentAttempt} failed with status ${response.status} for ${details.url.slice(0, 100)}...`,
              );
              if (currentAttempt < attempts) {
                const delay = initialDelay * Math.pow(2, currentAttempt - 1);
                console.log(`[GM_Retry] Retrying in ${delay}ms...`);
                setTimeout(() => tryRequest(currentAttempt + 1), delay);
              } else {
                reject(
                  new Error(
                    `[GM] Request failed after ${attempts} attempts with status ${response.status}: ${response.statusText}`,
                  ),
                );
              }
            }
          },
          onerror: (error: any) => {
            console.warn(
              `[GM_Retry] Attempt ${currentAttempt} failed with network error:`,
              error,
            );
            if (currentAttempt < attempts) {
              const delay = initialDelay * Math.pow(2, currentAttempt - 1);
              console.log(`[GM_Retry] Retrying in ${delay}ms...`);
              setTimeout(() => tryRequest(currentAttempt + 1), delay);
            } else {
              reject(
                new Error(
                  `[GM] Network request failed after ${attempts} attempts: ${JSON.stringify(error)}`,
                ),
              );
            }
          },
          ontimeout: () => {
            console.warn(`[GM_Retry] Attempt ${currentAttempt} timed out.`);
            if (currentAttempt < attempts) {
              const delay = initialDelay * Math.pow(2, currentAttempt - 1);
              console.log(`[GM_Retry] Retrying in ${delay}ms...`);
              setTimeout(() => tryRequest(currentAttempt + 1), delay);
            } else {
              reject(
                new Error(`[GM] Request timed out after ${attempts} attempts.`),
              );
            }
          },
        });
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
      .task-selector-task-list-container { flex-grow: 1; overflow-y: auto; overflow-x: hidden; padding: 0 5px; position: relative; scrollbar-width: none; -ms-overflow-style: none; }
      .task-selector-task-list-container::-webkit-scrollbar { display: none; }
      .task-selector-task-list-container::before, .task-selector-task-list-container::after { content: ''; display: block; height: 5px; }
      .task-selector-task-item { padding: 5px 8px; margin: 0 0 5px 0; background-color: #fff; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; height: ${
        TASK_ITEM_HEIGHT - 12
      }px; display: flex; align-items: center; transition: background-color 0.1s ease, border-color 0.1s ease; position: relative; user-select: none; }
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
      .task-progress-bar { height: 100%; width: 0%; background-color: #76c7c0; border-radius: 5px 0 0 5px; transition: width 0.3s ease-out; }
      .task-progress-bar.completed { background-color: #a0d8a0; border-radius: 5px; }
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
  function createParentTaskNode(parentTask: ParentTask): DocumentFragment {
    const fragment = document.createDocumentFragment();
    const pItem = document.createElement("div");
    pItem.className = "task-selector-task-item task-selector-parent-task";
    pItem.dataset.bvId = parentTask.bv;
    pItem.style.height = `${PARENT_TASK_ITEM_HEIGHT - 12}px`;

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

    pItem.appendChild(expander);
    pItem.appendChild(titleSpan);

    pItem.setAttribute("draggable", "false");
    fragment.appendChild(pItem);

    // Append child nodes if the parent is expanded
    if (parentTask.isExpanded) {
      parentTask.children.forEach((childTask) => {
        fragment.appendChild(
          createChildTaskNode(childTask, parentTask.bv, parentTask.MediaId),
        );
      });
    }
    return fragment;
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
    i.style.height = `${CHILD_TASK_ITEM_HEIGHT - 12}px`;
    i.style.marginLeft = "20px"; // Indent child tasks

    if (selectedTasks[task.id] && !selectedTasks[task.id].marked)
      i.classList.add("selected");
    if (selectedTasks[task.id] && selectedTasks[task.id].marked)
      i.classList.add("marked");

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
      if (taskListContainer)
        taskListContainer.innerHTML =
          '<div style="height: 5px;"></div><div style="height: 5px;"></div>'; // Spacers
      if (state) state.lastRenderedScrollTop = -1;
      return;
    }

    const parentTasks = allTasksData[currentTabId].tasks;
    const scrollTop = taskListContainer.scrollTop;
    const containerHeight = taskListContainer.clientHeight;
    state.taskScrollTop = scrollTop;

    if (containerHeight <= 0 && !forceUpdate) return;

    // --- Simplified rendering - Iterate all and append ---
    // This bypasses complex virtualization for now. For large lists, this will be slow.
    const fragment = document.createDocumentFragment();
    taskListContainer.innerHTML = ""; // Clear

    const topSpacer = document.createElement("div"); // Keep top spacer for padding
    topSpacer.style.height = `5px`;
    fragment.appendChild(topSpacer);

    parentTasks.forEach((pt) => {
      fragment.appendChild(createParentTaskNode(pt));
    });

    const bottomSpacer = document.createElement("div"); // Keep bottom spacer
    bottomSpacer.style.height = `5px`;
    fragment.appendChild(bottomSpacer);

    taskListContainer.appendChild(fragment);
    state.lastRenderedScrollTop = scrollTop; // This isn't accurate for non-virtualized, but for consistency
    state.needsRender = false;

    if (forceUpdate) {
      const forcedScrollTop = state.taskScrollTop ?? 0;
      requestAnimationFrame(() => {
        if (taskListContainer) taskListContainer.scrollTop = forcedScrollTop;
        // state.lastRenderedScrollTop = taskListContainer?.scrollTop ?? forcedScrollTop; // Re-set after scroll
      });
    }
    // console.log("Rendered tasks for tab:", currentTabId);
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

  function handleMouseDownHeader(event: MouseEvent): void {
    if (
      event.target === collapseIndicator ||
      (event.target as HTMLElement).closest(".task-selector-resizer")
    )
      return;

    isDragging = true;
    const r = container!.getBoundingClientRect();
    dragOffset = { x: event.clientX - r.left, y: event.clientY - r.top };
    container!.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";

    document.addEventListener("mousemove", handleMouseMoveDrag, {
      passive: false,
    });
    document.addEventListener("mouseup", handleMouseUpDrag);
  }

  function handleMouseMoveDrag(event: MouseEvent): void {
    if (!isDragging || !container) return;
    event.preventDefault();
    let nt = event.clientY - dragOffset.y;
    let nl = event.clientX - dragOffset.x;
    nt = Math.max(0, Math.min(nt, window.innerHeight - container.offsetHeight));
    nl = Math.max(0, Math.min(nl, window.innerWidth - container.offsetWidth));
    container.style.top = `${nt}px`;
    container.style.left = `${nl}px`;
  }

  function handleMouseUpDrag(): void {
    if (!isDragging) return;
    isDragging = false;
    if (container) {
      if (windowState.collapsed) container.style.cursor = "grab";
      else if (header) {
        container.style.cursor = "";
        header.style.cursor = "grab";
      }
      windowState.top = container.style.top;
      windowState.left = container.style.left;
    }
    document.removeEventListener("mousemove", handleMouseMoveDrag);
    document.removeEventListener("mouseup", handleMouseUpDrag);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  }

  function handleMouseDownResize(event: MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    isResizing = true;
    resizeHandle = event.target as HTMLElement;
    dragOffset = {
      x: event.clientX,
      y: event.clientY,
      width: container!.offsetWidth,
      height: container!.offsetHeight,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
    document.addEventListener("mousemove", handleMouseMoveResize, {
      passive: false,
    });
    document.addEventListener("mouseup", handleMouseUpResize);
  }

  function handleMouseMoveResize(event: MouseEvent): void {
    if (!isResizing || !container) return;
    event.preventDefault();
    const dx = event.clientX - dragOffset.x;
    const dy = event.clientY - dragOffset.y;
    // 由于 isResizing 为 true，我们确信 dragOffset.width 和 dragOffset.height 存在
    let nW = dragOffset.width! + dx;
    let nH = dragOffset.height! + dy;
    const s = getComputedStyle(container);
    const minW = parseInt(s.minWidth) || 120;
    const minH = parseInt(s.minHeight) || 70;
    nW = Math.max(minW, nW);
    nH = Math.max(minH, nH);
    container.style.width = `${nW}px`;
    container.style.height = `${nH}px`;
    if (currentTabId && tabStates[currentTabId])
      tabStates[currentTabId].needsRender = true;
    Object.values(progressWindows).forEach((pw) => {
      if (pw.state) pw.state.needsRender = true;
    });
    scheduleTick();
  }
  function handleMouseUpResize(): void {
    if (!isResizing) return;
    isResizing = false;
    document.removeEventListener("mousemove", handleMouseMoveResize);
    document.removeEventListener("mouseup", handleMouseUpResize);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    if (container) {
      windowState.width = container.style.width;
      windowState.height = container.style.height;
      if (currentTabId && tabStates[currentTabId]) {
        tabStates[currentTabId].needsRender = true;
        tabStates[currentTabId].lastRenderedScrollTop = -1;
      }
      Object.values(progressWindows).forEach((pw) => {
        if (pw.state) {
          pw.state.needsRender = true;
          pw.state.lastRenderedScrollTop = -1;
        }
      });
      scheduleTick();
    }
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

    isSelectingBox = true;
    initialSelectedInTabForBoxOp = {};
    if (currentTabId && allTasksData[currentTabId]) {
      allTasksData[currentTabId].tasks.forEach((parentTask) => {
        if (parentTask.isExpanded) {
          parentTask.children.forEach((childTask) => {
            if (
              selectedTasks[childTask.id] &&
              !selectedTasks[childTask.id].marked
            ) {
              initialSelectedInTabForBoxOp[childTask.id] = true;
            }
          });
        }
      });
    }

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
      initialSelectedInTabForBoxOp = {};
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
      initialSelectedInTabForBoxOp = {};
      isSelectingBox = false; // Ensure this is always reset
      selectionBoxElement = null;

      console.log("Drag selection cleanup completed in finally block.");
    }
  }

  function handleChildTaskClick(event: MouseEvent): void {
    event.stopPropagation();
    const targetItem = event.currentTarget as HTMLDivElement;
    const childTaskId = targetItem.dataset.taskId as string; // This is CID
    const parentBvId = targetItem.dataset.bv as string;
    const ParentMediaId = targetItem.dataset.MediaId as string;

    if (!childTaskId || !parentBvId) return;

    const childTaskData = findChildTaskByIdGlobal(childTaskId); // Helper to find the specific child task object
    if (!childTaskData) return;

    if (selectedTasks[childTaskId] && !selectedTasks[childTaskId].marked) {
      // Deselecting child
      targetItem.classList.remove("selected", "marked");
      delete selectedTasks[childTaskId];
    } else {
      // Selecting child
      targetItem.classList.add("selected");
      targetItem.classList.remove("marked");
      selectedTasks[childTaskId] = { ...childTaskData, marked: false }; // childTaskData already has id, name, bv
    }

    // Sync with BiliSelectScript for the parent BV
    if (window.BiliSelectScriptAPI) {
      // Check if *any* child of this parentBV is selected
      const anyChildStillSelected =
        TaskSelectorManager.isAnyTaskSelectedForBv(parentBvId);
      window.BiliSelectScriptAPI.selectVideoCardByBv(
        parentBvId,
        anyChildStillSelected,
        true,
        ParentMediaId,
      );
    }
  }

  // Helper to find a child task by its CID across all tabs/parent tasks
  function findChildTaskByIdGlobal(childId: string): Task | null {
    for (const tabKey in allTasksData) {
      const tab = allTasksData[tabKey];
      for (const parent of tab.tasks) {
        const foundChild = parent.children.find(
          (child) => child.id === childId,
        );
        if (foundChild) return foundChild;
      }
    }
    return null;
  }
  // `findTaskByIdGlobal` might need to be renamed or rethought if its previous meaning was different.
  // The original `findTaskByIdGlobal` might have been looking for what are now parent tasks by their 'id' (which was BV).
  // Now, selection is by CID.

  // In TaskSelectScript
  function updateSelectionFromBox(isFinal: boolean = false): void {
    if (!selectionBoxElement || (!isSelectingBox && !isFinal)) return;

    const boxRectVP = selectionBoxElement.getBoundingClientRect();
    if (boxRectVP.width === 0 && boxRectVP.height === 0 && !isFinal) return;

    // Query only for child task items that are currently rendered
    const childTaskItems = taskListContainer?.querySelectorAll<HTMLDivElement>(
      ".task-selector-child-task",
    );
    if (!childTaskItems || childTaskItems.length === 0) return;

    const bvsAffected = new Set<string>();

    childTaskItems.forEach((item) => {
      const itemRectVP = item.getBoundingClientRect();
      const childTaskId = item.dataset.taskId; // This is the CID
      const parentBvId = item.dataset.bv; // Parent BV ID

      if (!childTaskId || !parentBvId) return; // Skip if essential data is missing

      const childTaskFullData = findChildTaskByIdGlobal(childTaskId); // For name, etc.

      const overlaps = !(
        itemRectVP.right < boxRectVP.left ||
        itemRectVP.left > boxRectVP.right ||
        itemRectVP.bottom < boxRectVP.top ||
        itemRectVP.top > boxRectVP.bottom
      );

      if (isFinal) {
        if (overlaps) {
          if (initialSelectedInTabForBoxOp[childTaskId]) {
            // Was selected at start of box op, now toggle OFF
            delete selectedTasks[childTaskId];
            item.classList.remove("selected", "marked");
          } else {
            // Was NOT selected (or was marked) at start, now toggle ON
            if (!childTaskFullData) {
              console.warn(
                `Child task data not found for CID: ${childTaskId} during final box selection.`,
              );
              return;
            }
            // Update selectedTasks (global state for child tasks)
            selectedTasks[childTaskId] = {
              id: childTaskId,
              name: childTaskFullData.name,
              marked: false,
              bv: parentBvId, // Store parent BV
            };
            item.classList.add("selected");
            item.classList.remove("marked");
          }
        } else {
          // Item is OUTSIDE the selection box on mouse up.
          // Ensure its classList matches the current global `selectedTasks` state.
          if (
            selectedTasks[childTaskId] &&
            !selectedTasks[childTaskId].marked
          ) {
            item.classList.add("selected");
            item.classList.remove("marked");
          } else if (
            selectedTasks[childTaskId] &&
            selectedTasks[childTaskId].marked
          ) {
            item.classList.add("marked");
            item.classList.remove("selected");
          } else {
            item.classList.remove("selected", "marked");
          }
        }
        bvsAffected.add(parentBvId); // Add parent BV of this child to affected set
      } else {
        // Previewing selection (mousemove)
        if (overlaps) {
          item.classList.toggle(
            "selected",
            !initialSelectedInTabForBoxOp[childTaskId],
          );
          item.classList.remove("marked");
        } else {
          item.classList.toggle(
            "selected",
            !!initialSelectedInTabForBoxOp[childTaskId],
          );
          if (
            initialSelectedInTabForBoxOp[childTaskId] &&
            selectedTasks[childTaskId]?.marked
          ) {
            item.classList.remove("selected");
            item.classList.add("marked");
          } else {
            item.classList.remove("marked");
          }
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
          childTaskItems[0].dataset.MediaId,
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
  function confirmSelection(): string | undefined {
    // Filter selectedTasks which are sub-tasks (CIDs)
    const subTasksToProcess: SelectedTask[] = Object.values(
      selectedTasks,
    ).filter((t) => t && !t.marked);
    if (subTasksToProcess.length === 0) return undefined;

    console.log(`Confirming ${subTasksToProcess.length} sub-tasks.`);
    subTasksToProcess.forEach((st) => {
      if (selectedTasks[st.id]) selectedTasks[st.id].marked = true;
    });

    // createProgressWindow expects an array of items that look like { id, name, bv, marked(false initially for progress) }
    // The current subTasksToProcess fits this if we treat its 'id' as the task ID for progress.
    const progressTasks = subTasksToProcess.map((st) => ({
      id: st.id, // cid
      name: st.name, // part name
      bv: st.bv, // parent bv
      marked: false, // for progress window, this 'marked' is irrelevant, it's about download state
    }));

    const nId = createProgressWindow(progressTasks); // Progress window tracks CIDs
    console.log(`Created progress window: ${nId}`);

    const newSelectedAfterConfirm: Record<string, SelectedTask> = {};
    Object.values(selectedTasks).forEach((task) => {
      if (task.marked) newSelectedAfterConfirm[task.id] = task;
    });
    selectedTasks = newSelectedAfterConfirm;

    renderTasksForCurrentTab(true); // Re-render to update styles
    // The `download` function needs to be adapted to handle an array of these sub-task objects.
    // It already uses task.id (CID) and task.bv.
    download(selectedTasks, nId); // Pass the currently marked tasks (CIDs)
    console.log(
      "Selection confirmed. Active (non-marked) selection cleared, marked sub-tasks remain.",
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
    const processSingleDownload = async (
      task: SelectedTask,
    ): Promise<string> => {
      try {
        // --- Step A: Get video URL (Retries are less critical here, but can be added) ---
        console.log(`[Pool] 获取 ${task.name} 的视频信息...`);
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
        if (jsonResponse.code !== 0 || !jsonResponse.data?.durl?.[0]?.url) {
          throw new Error(
            `[GM] API 响应无效 for ${task.name}. Response: ${videoInfoText}`,
          );
        }
        const videoUrl = jsonResponse.data.durl[0].url;

        // --- Step B: Download video Blob with RETRIES and a LONG TIMEOUT ---
        console.log(
          `  [Pool] 开始下载 ${task.name} (URL: ...${videoUrl.slice(-30)})`,
        );
        const videoBlob = await gmFetchWithRetry<Blob>(
          {
            method: "GET",
            url: videoUrl,
            responseType: "blob",
            headers: { Referer: "https://www.bilibili.com/" },
            timeout: 600000, // <-- Set a LONG timeout (10 minutes) for the download itself
            onprogress: (progressEvent: any) => {
              if (progressEvent.lengthComputable && progressWindows[wid]) {
                const percent = Math.round(
                  (progressEvent.loaded / progressEvent.total) * 100,
                );
                progressWindows[wid].updateProgress(String(task.id), percent);
              }
            },
          },
          DOWNLOAD_RETRY_ATTEMPTS,
          DOWNLOAD_RETRY_DELAY_MS,
        );

        // --- Step C: Add to Zip ---
        if (videoBlob && videoBlob.size > 0) {
          zip.file(task.name + ".mp4", videoBlob);
          if (progressWindows[wid]) {
            progressWindows[wid].updateProgress(String(task.id), 100);
          }
          console.log(
            `    [Pool] Done: ${task.name}. Blob size: ${videoBlob.size}, added to zip.`,
          );
          return `成功处理: ${task.name}`;
        } else {
          console.warn(
            `  [Pool] 下载到的 ${task.name} 数据为空或无效，未添加到 zip。`,
          );
          return `警告: ${task.name} 数据为空`;
        }
      } catch (err: any) {
        console.error(
          `  [Pool] FATAL Error after retries for ${task.name}:`,
          err.message,
        );
        if (progressWindows[wid]) {
          progressWindows[wid].updateProgress(String(task.id), 0); // Mark as failed
        }
        throw err; // Re-throw to make the pool stop
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

      // ... (The code for creating a new window and the download link is unchanged)
      // ...
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
    // Target only the selectable child task items, which have the necessary data attributes.
    const childTaskItems = taskListContainer.querySelectorAll<HTMLDivElement>(
      ".task-selector-child-task",
    );

    let newlySelectedCount = 0;
    const affectedBvIds = new Set<string>();

    childTaskItems.forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const taskId = item.dataset.taskId; // The task's CID
      const parentBvId = item.dataset.bv; // The parent video's BV ID

      if (!taskId || !parentBvId) {
        return; // Skip if essential data is missing
      }

      // Check if the item is intersecting with the visible area of the scroll container
      const isVisible =
        itemRect.top < containerRect.bottom &&
        itemRect.bottom > containerRect.top;

      const isCurrentlySelected =
        selectedTasks[taskId] && !selectedTasks[taskId].marked;

      // If the task is visible but not currently selected, select it.
      if (isVisible && !isCurrentlySelected) {
        // Find the complete task data (including name) from the global state
        const taskData = findChildTaskByIdGlobal(taskId);
        if (!taskData) {
          console.warn(
            `selectVisibleTasks: Could not find task data for visible item with CID ${taskId}`,
          );
          return; // Continue to the next item in the loop
        }

        // 1. Update the UI by changing the element's class
        item.classList.add("selected");
        item.classList.remove("marked");

        // 2. Update the application's global selection state
        selectedTasks[taskId] = {
          ...taskData, // Use the full task data
          marked: false, // Ensure it's not marked as processed
        };

        newlySelectedCount++;
        affectedBvIds.add(parentBvId);
      }
    });

    // 3. If any tasks were newly selected, sync the state with the BiliSelect script
    if (newlySelectedCount > 0 && window.BiliSelectScriptAPI) {
      affectedBvIds.forEach((bvId) => {
        // Instruct the BiliSelect script to highlight the corresponding video card
        window.BiliSelectScriptAPI?.selectVideoCardByBv(bvId, true, true);
      });
    }

    console.log(
      `Selected ${newlySelectedCount} visible tasks. Total active selections:`,
      Object.keys(selectedTasks).filter(
        (id) => selectedTasks[id] && !selectedTasks[id].marked,
      ).length,
    );
  }

  function deselectVisibleTasks(): void {
    if (!taskListContainer || windowState.collapsed) return;
    const lr = taskListContainer.getBoundingClientRect();
    const tis = taskListContainer.querySelectorAll<HTMLDivElement>(
      ".task-selector-task-item",
    );
    let c = 0; // Count of deselected tasks
    const bvsToUpdate = new Set<string>(); // Store BV IDs whose selection state needs sync

    tis.forEach((i) => {
      const ir = i.getBoundingClientRect();
      const taskId = i.dataset.taskId;
      if (!taskId) return;

      // We need the BV to sync, even if taskData itself is not strictly needed for deselection
      const bvId = selectedTasks[taskId].bv || findTaskByIdGlobal(taskId);

      const isVisible = ir.top < lr.bottom && ir.bottom > lr.top;
      const isCurrentlySelected =
        selectedTasks[taskId] && !selectedTasks[taskId].marked;

      if (isVisible && isCurrentlySelected) {
        i.classList.remove("selected", "marked"); // Remove both, just in case
        delete selectedTasks[taskId];
        c++;
        if (bvId) {
          // Only add if we have a BV ID
          bvsToUpdate.add(bvId);
        }
      }
    });

    if (c > 0 && window.BiliSelectScriptAPI) {
      bvsToUpdate.forEach((bvId) => {
        // Check if any other task for this BV is still selected in TaskManager
        const anyOtherTaskForBvIsSelected =
          TaskSelectorManager.isAnyTaskSelectedForBv(bvId);
        // If no other tasks for this BV are selected, then deselect the video card
        if (!anyOtherTaskForBvIsSelected) {
          window.BiliSelectScriptAPI!.selectVideoCardByBv(bvId, false, true);
        }
        // If other tasks for this BV are still selected, the video card should remain selected.
      });
    }

    console.log(
      `Deselected ${c} visible tasks. Total active:`,
      Object.keys(selectedTasks).filter(
        (id) => selectedTasks[id] && !selectedTasks[id].marked,
      ).length,
    );
  }

  function selectAllTasksInTab(): void {
    // Selects all *children* tasks in the current tab
    if (!currentTabId || !allTasksData[currentTabId]) return;
    const parentTasksInCurrentTab = allTasksData[currentTabId].tasks;
    const bvsToUpdate = new Set<string>();
    let changed = false;

    parentTasksInCurrentTab.forEach((pt) => {
      pt.children.forEach((child) => {
        if (!selectedTasks[child.id] || selectedTasks[child.id].marked) {
          selectedTasks[child.id] = { ...child, marked: false };
          changed = true;
        }
      });
      if (pt.children.length > 0) bvsToUpdate.add(pt.bv);
    });

    if (changed && window.BiliSelectScriptAPI) {
      bvsToUpdate.forEach((bvId) => {
        window.BiliSelectScriptAPI!.selectVideoCardByBv(bvId, true, true);
      });
    }
    if (changed) console.log(`Selected all sub-tasks in tab ${currentTabId}.`);
    renderTasksForCurrentTab(true); // Full re-render to update UI
  }

  function deselectAllTasks(): void {
    // Deselects all non-marked *children* tasks globally
    const bvsToUpdate = new Set<string>();

    // Collect BVs of tasks about to be deselected
    Object.values(selectedTasks).forEach((selTask) => {
      if (!selTask.marked && selTask.bv) {
        bvsToUpdate.add(selTask.bv);
      }
    });

    // Rebuild selectedTasks to only contain marked items
    const newSelectedTasks: Record<string, SelectedTask> = {};
    Object.values(selectedTasks).forEach((selTask) => {
      if (selTask.marked) {
        newSelectedTasks[selTask.id] = selTask;
      }
    });
    selectedTasks = newSelectedTasks;

    // Update UI (renderTasksForCurrentTab will handle this better)
    // taskListContainer?.querySelectorAll(".task-selector-child-task.selected").forEach(i => {
    //     i.classList.remove("selected");
    // });
    renderTasksForCurrentTab(true); // Re-render needed for global change

    if (window.BiliSelectScriptAPI) {
      bvsToUpdate.forEach((bvId) => {
        // Since we deselected all non-marked, check if this BV still has any selected (should be false)
        const anyStillSelected =
          TaskSelectorManager.isAnyTaskSelectedForBv(bvId);
        if (!anyStillSelected) {
          // Should always be true here unless logic error
          window.BiliSelectScriptAPI!.selectVideoCardByBv(bvId, false, true);
        }
      });
    }
    console.log("Deselected all non-marked sub-tasks globally.");
  }

  // --- Progress Window Functions ---
  function createProgressWindow(tasksForWindow: SelectedTask[]): string {
    progressWindowCounter++;
    const windowId = `progress-window-${progressWindowCounter}`;

    const preparedTasks: ProgressTaskItem[] = tasksForWindow.map((t) => ({
      ...t, // Spread the SelectedTask properties
      progress: 0,
      windowId: windowId,
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

    progressWindows[windowId] = {
      element: pwC,
      listElement: pwL,
      closeButton: pwX,
      tasks: preparedTasks, // Store the prepared tasks here
      state: state,
      checkCompletion: () => checkProgressCompletion(windowId),
      updateProgress: (tid, p) => updateTaskProgressById(windowId, tid, p),
      renderItems: (f = false) => renderProgressItems(windowId, f),
      handleScroll: () => handleProgressScroll(windowId),
      handleMouseDownDrag: (event) =>
        handleProgressMouseDownDrag(event, windowId),
      handleMouseMoveDrag: null,
      handleMouseUpDrag: null,
      handleMouseDownResize: (event) =>
        handleProgressMouseDownResize(event, windowId),
      handleMouseMoveResize: null,
      handleMouseUpResize: null,
    };

    pwH.addEventListener(
      "mousedown",
      progressWindows[windowId].handleMouseDownDrag as EventListener,
    );
    pwR.addEventListener(
      "mousedown",
      progressWindows[windowId].handleMouseDownResize as EventListener,
    );
    pwL.addEventListener("scroll", progressWindows[windowId].handleScroll, {
      passive: true,
    });

    renderProgressItems(windowId, true);
    progressWindows[windowId].checkCompletion();
    return windowId;
  }

  function closeProgressWindow(windowId: string): void {
    const pw = progressWindows[windowId];
    if (!pw?.element) return;

    const headerEl = pw.element.querySelector<HTMLDivElement>(
      ".task-progress-header",
    );
    headerEl?.removeEventListener(
      "mousedown",
      pw.handleMouseDownDrag as EventListener,
    );

    const resizerEl = pw.element.querySelector<HTMLDivElement>(
      ".task-progress-resizer",
    );
    resizerEl?.removeEventListener(
      "mousedown",
      pw.handleMouseDownResize as EventListener,
    );

    pw.listElement?.removeEventListener("scroll", pw.handleScroll);

    if (pw.handleMouseMoveDrag)
      document.removeEventListener("mousemove", pw.handleMouseMoveDrag);
    if (pw.handleMouseUpDrag)
      document.removeEventListener("mouseup", pw.handleMouseUpDrag);
    if (pw.handleMouseMoveResize)
      document.removeEventListener("mousemove", pw.handleMouseMoveResize);
    if (pw.handleMouseUpResize)
      document.removeEventListener("mouseup", pw.handleMouseUpResize);

    pw.element.remove();
    delete progressWindows[windowId];
  }

  function updateTaskProgressById(wId: string, tId: string, p: number): void {
    const pw = progressWindows[wId];
    if (!pw) return;
    const taskItem = pw.tasks.find((t) => t.id === tId);
    if (taskItem) {
      taskItem.progress = Math.max(0, Math.min(100, p));
      const itemNode = pw.listElement?.querySelector<HTMLDivElement>(
        `.task-progress-item[data-task-id="${tId}"]`,
      );
      if (itemNode) {
        const progressBar =
          itemNode.querySelector<HTMLDivElement>(".task-progress-bar");
        if (progressBar) {
          progressBar.style.width = `${taskItem.progress}%`;
          progressBar.classList.toggle("completed", taskItem.progress === 100);
        }
      }
      pw.checkCompletion();
    }
  }

  function checkProgressCompletion(wId: string): void {
    const pw = progressWindows[wId];
    if (!pw?.closeButton) return;
    const allCompleted = pw.tasks.every((t) => t.progress === 100);
    pw.closeButton.classList.toggle("visible", allCompleted);
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

  let currentProgressDrag: {
    windowId: string | null;
    offsetX: number;
    offsetY: number;
    moveHandler: ((event: MouseEvent) => void) | null;
    upHandler: ((event: MouseEvent) => void) | null;
  } = {
    windowId: null,
    offsetX: 0,
    offsetY: 0,
    moveHandler: null,
    upHandler: null,
  };

  function handleProgressMouseDownDrag(
    event: MouseEvent,
    windowId: string,
  ): void {
    event.stopPropagation();
    const pwData = progressWindows[windowId];
    if (
      !pwData?.element ||
      (event.target as HTMLElement).closest(
        ".task-progress-close-btn, .task-progress-resizer",
      )
    )
      return;

    currentProgressDrag.windowId = windowId;
    const rect = pwData.element.getBoundingClientRect();
    currentProgressDrag.offsetX = event.clientX - rect.left;
    currentProgressDrag.offsetY = event.clientY - rect.top;

    currentProgressDrag.moveHandler = (event: MouseEvent) =>
      handleProgressMouseMoveDrag(event);
    currentProgressDrag.upHandler = (event: MouseEvent) =>
      handleProgressMouseUpDrag(event);

    // Store handlers on the specific progress window data for reliable removal
    pwData.handleMouseMoveDrag = currentProgressDrag.moveHandler;
    pwData.handleMouseUpDrag = currentProgressDrag.upHandler;

    pwData.element.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing"; // Apply to body for wider capture

    document.addEventListener("mousemove", currentProgressDrag.moveHandler, {
      passive: false,
    });
    document.addEventListener("mouseup", currentProgressDrag.upHandler);
  }

  function handleProgressMouseMoveDrag(event: MouseEvent): void {
    if (!currentProgressDrag.windowId) return;
    event.preventDefault();
    const pwData = progressWindows[currentProgressDrag.windowId];
    if (!pwData?.element) return;

    let newTop = event.clientY - currentProgressDrag.offsetY;
    let newLeft = event.clientX - currentProgressDrag.offsetX;
    const el = pwData.element;

    newTop = Math.max(
      0,
      Math.min(newTop, window.innerHeight - el.offsetHeight),
    );
    newLeft = Math.max(
      0,
      Math.min(newLeft, window.innerWidth - el.offsetWidth),
    );

    el.style.top = `${newTop}px`;
    el.style.left = `${newLeft}px`;
  }

  function handleProgressMouseUpDrag(event: MouseEvent): void {
    void event;
    if (!currentProgressDrag.windowId) return;
    const WID = currentProgressDrag.windowId; // Capture before reset
    const pwData = progressWindows[WID];

    if (pwData?.element) {
      pwData.element.style.cursor = ""; // Reset element cursor
      pwData.element
        .querySelector<HTMLDivElement>(".task-progress-header")
        ?.style.setProperty("cursor", "grab");
      pwData.state.top = pwData.element.style.top;
      pwData.state.left = pwData.element.style.left;

      // Remove specific handlers stored on pwData
      if (pwData.handleMouseMoveDrag)
        document.removeEventListener("mousemove", pwData.handleMouseMoveDrag);
      if (pwData.handleMouseUpDrag)
        document.removeEventListener("mouseup", pwData.handleMouseUpDrag);
      pwData.handleMouseMoveDrag = null;
      pwData.handleMouseUpDrag = null;
    } else {
      // Fallback if pwData somehow gone, remove global currentProgressDrag handlers
      if (currentProgressDrag.moveHandler)
        document.removeEventListener(
          "mousemove",
          currentProgressDrag.moveHandler,
        );
      if (currentProgressDrag.upHandler)
        document.removeEventListener("mouseup", currentProgressDrag.upHandler);
    }

    document.body.style.userSelect = "";
    document.body.style.cursor = ""; // Reset body cursor

    currentProgressDrag = {
      windowId: null,
      offsetX: 0,
      offsetY: 0,
      moveHandler: null,
      upHandler: null,
    };
  }

  let currentProgressResize: {
    windowId: string | null;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    moveHandler: ((event: MouseEvent) => void) | null;
    upHandler: ((event: MouseEvent) => void) | null;
  } = {
    windowId: null,
    startX: 0,
    startY: 0,
    startW: 0,
    startH: 0,
    moveHandler: null,
    upHandler: null,
  };

  function handleProgressMouseDownResize(
    event: MouseEvent,
    windowId: string,
  ): void {
    event.stopPropagation();
    event.preventDefault();
    const pwData = progressWindows[windowId];
    if (!pwData?.element) return;

    currentProgressResize.windowId = windowId;
    const rect = pwData.element.getBoundingClientRect();
    currentProgressResize.startX = event.clientX;
    currentProgressResize.startY = event.clientY;
    currentProgressResize.startW = rect.width;
    currentProgressResize.startH = rect.height;

    currentProgressResize.moveHandler = (event: MouseEvent) =>
      handleProgressMouseMoveResize(event);
    currentProgressResize.upHandler = (event: MouseEvent) =>
      handleProgressMouseUpResize(event);

    pwData.handleMouseMoveResize = currentProgressResize.moveHandler;
    pwData.handleMouseUpResize = currentProgressResize.upHandler;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";

    document.addEventListener("mousemove", currentProgressResize.moveHandler, {
      passive: false,
    });
    document.addEventListener("mouseup", currentProgressResize.upHandler);
  }

  function handleProgressMouseMoveResize(event: MouseEvent): void {
    if (!currentProgressResize.windowId) return;
    event.preventDefault();
    const pwData = progressWindows[currentProgressResize.windowId];
    if (!pwData?.element) return;

    const dx = event.clientX - currentProgressResize.startX;
    const dy = event.clientY - currentProgressResize.startY;
    let newWidth = currentProgressResize.startW + dx;
    let newHeight = currentProgressResize.startH + dy;

    const computedStyle = getComputedStyle(pwData.element);
    const minWidth = parseInt(computedStyle.minWidth) || 150;
    const minHeight = parseInt(computedStyle.minHeight) || 80;

    newWidth = Math.max(minWidth, newWidth);
    newHeight = Math.max(minHeight, newHeight);

    pwData.element.style.width = `${newWidth}px`;
    pwData.element.style.height = `${newHeight}px`;

    if (pwData.state) pwData.state.needsRender = true;
    scheduleTick();
  }

  function handleProgressMouseUpResize(event: MouseEvent): void {
    void event;
    if (!currentProgressResize.windowId) return;
    const WID = currentProgressResize.windowId;
    const pwData = progressWindows[WID];

    if (pwData?.element) {
      pwData.state.width = pwData.element.style.width;
      pwData.state.height = pwData.element.style.height;
      if (pwData.state) {
        pwData.state.needsRender = true;
        pwData.state.lastRenderedScrollTop = -1; // Force full re-render of content
      }
      scheduleTick();

      if (pwData.handleMouseMoveResize)
        document.removeEventListener("mousemove", pwData.handleMouseMoveResize);
      if (pwData.handleMouseUpResize)
        document.removeEventListener("mouseup", pwData.handleMouseUpResize);
      pwData.handleMouseMoveResize = null;
      pwData.handleMouseUpResize = null;
    } else {
      if (currentProgressResize.moveHandler)
        document.removeEventListener(
          "mousemove",
          currentProgressResize.moveHandler,
        );
      if (currentProgressResize.upHandler)
        document.removeEventListener(
          "mouseup",
          currentProgressResize.upHandler,
        );
    }

    document.body.style.userSelect = "";
    document.body.style.cursor = "";

    currentProgressResize = {
      windowId: null,
      startX: 0,
      startY: 0,
      startW: 0,
      startH: 0,
      moveHandler: null,
      upHandler: null,
    };
  }

  // --- Helper Functions ---
  function findTaskByIdGlobal(taskId: string): string | null {
    for (const tabId in allTasksData) {
      const task = allTasksData[tabId].tasks.find((t) => t.bv === taskId);
      if (task) return task.bv;
    }
    return null;
  }

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

    header.addEventListener(
      "mousedown",
      handleMouseDownHeader as EventListener,
    );
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

    tabsContainer = document.createElement("div");
    tabsContainer.className = "task-selector-tabs-container";
    tabsContainer.addEventListener("scroll", debouncedTabsScrollSave, {
      passive: true,
    });

    const rsz = document.createElement("div");
    rsz.className = "task-selector-resizer";
    rsz.addEventListener("mousedown", handleMouseDownResize as EventListener);

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
    console.log("Task Selector Initialized.");
  }

  // --- Public API ---
  const TaskSelectorManager: TaskSelectorManagerAPI = {
    addTaskData: (
      tId: string, // tabId
      tN: string, // tabName
      parentTaskInputs: {
        videoTitle: string;
        bvId: string;
        pages: { cid: string; part: string }[];
      }[],
      autoSelectNewChildren: boolean = false,
    ) => {
      if (!tId || !tN || !Array.isArray(parentTaskInputs)) {
        console.error("Invalid addTaskData args");
        return;
      }
      const sId = String(tId);
      let needsReRenderCurrentTab = false;
      let tabCreated = false;

      if (!allTasksData[sId]) {
        allTasksData[sId] = { name: tN, tasks: [] };
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
        const existingParentTask = tabParentTasks.find(
          (pt) => pt.bv === videoInput.bvId,
        );

        if (existingParentTask) {
          // Parent task (video) already exists. Maybe update children if needed, or ignore.
          // For now, let's assume if parent exists, children are also up-to-date.
          // If autoSelectNewChildren is true, we might need to select its children.
          if (autoSelectNewChildren) {
            existingParentTask.children.forEach((childTask) => {
              if (
                !selectedTasks[childTask.id] ||
                selectedTasks[childTask.id].marked
              ) {
                selectedTasks[childTask.id] = { ...childTask, marked: false };
              }
            });
            needsReRenderCurrentTab = true;
          }
        } else {
          // New parent task (video)
          const children: Task[] = videoInput.pages.map((page) => ({
            id: String(page.cid), // This is the actual task ID for selection
            name: String(page.part),
            bv: videoInput.bvId,
          }));

          if (children.length === 0) {
            // Should not happen if pages are fetched correctly
            console.warn(
              `No pages found for BV ${videoInput.bvId}, video title: ${videoInput.videoTitle}. Skipping.`,
            );
            return;
          }

          const newParentTask: ParentTask = {
            name: videoInput.videoTitle,
            bv: videoInput.bvId,
            children: children,
            isExpanded: false, // Default to collapsed
            MediaId: tId,
          };
          tabParentTasks.push(newParentTask);
          needsReRenderCurrentTab = true;

          if (autoSelectNewChildren) {
            newParentTask.children.forEach((childTask) => {
              selectedTasks[childTask.id] = { ...childTask, marked: false };
            });
            console.log(
              `TaskSelectorManager: Auto-selected all children for new video BV ${videoInput.bvId}`,
            );
          }
        }
      });

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
      return Object.keys(selectedTasks).filter(
        (id) => selectedTasks[id] && !selectedTasks[id].marked,
      );
    },

    destroy: () => {
      console.log("Destroying Task Selector...");
      if (!container) return;

      header?.removeEventListener(
        "mousedown",
        handleMouseDownHeader as EventListener,
      );
      collapseIndicator?.removeEventListener(
        "click",
        toggleCollapse as EventListener,
      );
      taskListContainer?.removeEventListener("scroll", handleTaskListScroll);
      taskListContainer?.removeEventListener(
        "mousedown",
        handleMouseDownTaskList as EventListener,
      );
      tabsContainer?.removeEventListener("scroll", debouncedTabsScrollSave);
      container
        .querySelector<HTMLDivElement>(".task-selector-resizer")
        ?.removeEventListener(
          "mousedown",
          handleMouseDownResize as EventListener,
        );

      buttonsContainer?.querySelectorAll("button").forEach((b) => {
        // Simple way to remove all listeners: replace node
        b.replaceWith(b.cloneNode(true));
      });

      Object.keys(progressWindows).forEach(closeProgressWindow); // Closes and cleans listeners for progress windows

      container.remove();
      document.getElementById("task-selector-styles")?.remove();

      // Reset state variables
      allTasksData = {};
      selectedTasks = {};
      currentTabId = null;
      tabStates = {};
      windowState = {
        collapsed: true,
        top: "20px",
        left: "20px",
        width: "350px",
        height: "450px",
      };
      progressWindows = {};
      progressWindowCounter = 0;
      isDragging = false;
      isResizing = false;
      isSelectingBox = false;
      dragOffset = { x: 0, y: 0 };
      resizeHandle = null;
      selectionBoxStart = { x: 0, y: 0 };
      selectionBoxElement = null;
      initialSelectedInTabForBoxOp = {};
      tickScheduled = false;

      container = null;
      header = null;
      body = null;
      taskListContainer = null;
      tabsContainer = null;
      buttonsContainer = null;
      collapseIndicator = null;
      // selectionBoxElement already nulled

      delete window.TaskSelectorManager;
      console.log("Task Selector destroyed.");
    },
    selectTasksByBv: (bvId: string, shouldSelect: boolean) => {
      if (!bvId) return;
      console.log(
        `TaskSelectorManager.selectTasksByBv called for BV: ${bvId}, select: ${shouldSelect}`,
      );
      let changed = false;
      for (const tabId in allTasksData) {
        const parentTask = allTasksData[tabId].tasks.find(
          (pt) => pt.bv === bvId,
        );
        if (parentTask) {
          parentTask.children.forEach((child) => {
            const currentSelectedState =
              selectedTasks[child.id] && !selectedTasks[child.id].marked;
            if (shouldSelect && !currentSelectedState) {
              selectedTasks[child.id] = { ...child, marked: false };
              changed = true;
            } else if (!shouldSelect && currentSelectedState) {
              delete selectedTasks[child.id];
              changed = true;
            }
          });
          // No need to break, a BV might appear in multiple tabs if data is structured that way,
          // though typically a BV is unique to one favorite list (tab).
        }
      }

      if (changed) {
        console.log(
          `TaskSelectorManager: Children tasks for BV ${bvId} selection state changed to ${shouldSelect}. Re-rendering.`,
        );
        // Force re-render if current tab is affected
        if (
          currentTabId &&
          allTasksData[currentTabId]?.tasks.some((pt) => pt.bv === bvId) &&
          !windowState.collapsed &&
          taskListContainer
        ) {
          if (tabStates[currentTabId]) {
            tabStates[currentTabId].needsRender = true;
            tabStates[currentTabId].lastRenderedScrollTop = -1;
          }
          scheduleTick();
        }
      }
    },

    isTaskSelected: (taskId: string /* cid */): boolean => {
      return !!(selectedTasks[taskId] && !selectedTasks[taskId].marked);
    },

    isAnyTaskSelectedForBv: (bvId: string): boolean => {
      if (!bvId) return false;
      // Iterate through selectedTasks and check their bv property
      for (const taskId in selectedTasks) {
        const selTaskInfo = selectedTasks[taskId];
        if (selTaskInfo.bv === bvId && !selTaskInfo.marked) {
          return true;
        }
      }
      // Fallback: iterate allTasksData if selectedTasks might not be fully populated with BV (shouldn't happen)
      // for (const tabId in allTasksData) {
      //     const parentTask = allTasksData[tabId].tasks.find(pt => pt.bv === bvId);
      //     if (parentTask && parentTask.children.some(child => selectedTasks[child.id] && !selectedTasks[child.id].marked)) {
      //         return true;
      //     }
      // }
      return false;
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
