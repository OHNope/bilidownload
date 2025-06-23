import {
  TabData,
  TabState,
  WindowUiState,
  Task,
  ProgressWindowData,
} from "./types";

class States {
  // --- 配置常量 ---
  readonly MAX_CONCURRENT_DOWNLOADS = 10; // <-- ADD THIS. (4 is a safe number)
  readonly TASK_ITEM_HEIGHT = 35;
  readonly DOWNLOAD_RETRY_ATTEMPTS = 3; // <-- ADD THIS: How many times to retry a failed download
  readonly DOWNLOAD_RETRY_DELAY_MS = 2000; // <-- ADD THIS: Initial delay before the first retry
  readonly PROGRESS_ITEM_HEIGHT = 40;
  readonly PROGRESS_VISIBLE_ITEMS_BUFFER = 10;
  readonly SCROLL_RENDER_THRESHOLD = this.TASK_ITEM_HEIGHT / 2;
  // 新增常量 for hierarchical display
  readonly PARENT_TASK_ITEM_HEIGHT = 38; // Example height for parent tasks
  readonly CHILD_TASK_ITEM_HEIGHT = 32; // Example height for

  // --- 核心状态管理 ---
  allTasksData: Record<string, TabData> = {};
  activeDownloads = new Map<string, { abort: () => void }>();

  currentTabId: string | null = null;
  tabStates: Record<string, TabState> = {};
  windowState: WindowUiState = {
    collapsed: true,
    top: "20px",
    left: "20px",
    width: "350px",
    height: "450px",
  };

  // NEW: A Set to hold the IDs of actively selected (but not yet confirmed) tasks.
  selectedTaskIds = new Set<string>();

  // NEW: A Set to hold the IDs of tasks that have been confirmed for download.
  // This drives the "marked" visual style.
  markedTaskIds = new Set<string>();
  taskMap = new Map<string, Task>();
  // NEW: An array to hold all cleanup functions for listeners.
  readonly globalCleanupFunctions: (() => void)[] = [];

  // ... other state variables
  isResizing = false;
  resizeHandle: HTMLElement | null = null;
  isSelectingBox = false;
  selectionBoxStart = { x: 0, y: 0 };
  selectionBoxElement: HTMLDivElement | null = null;
  // 新增状态变量
  previewSelectedTaskIds = new Set<string>(); // <- 新增: 用于在拖拽期间管理预览选择状态
  lastIntersectionStatePerTask = new Map<string, boolean>(); // <- 新增: 记录每个任务的上一次相交状态
  // --- END: MODIFICATION ---

  progressWindows: Record<string, ProgressWindowData> = {};
  progressWindowCounter = 0;

  // --- 新增/修改用于框选和滚动的变量 ---
  lastClientX = 0;
  lastClientY = 0;
  autoScrollDirection = 0;
  readonly AUTO_SCROLL_ZONE_SIZE = 40;
  readonly AUTO_SCROLL_SPEED_MAX = 8;
  // --- 【新增】用于锚定坐标系的状态变量 ---
  startScrollTop = 0;
  startContainerRect: DOMRect | null = null;
  // --- 结束新增 ---

  tickScheduled = false;

  // --- DOM 元素引用 ---
  container: HTMLDivElement | null = null;
  header: HTMLDivElement | null = null;
  body: HTMLDivElement | null = null;
  taskListContainer: HTMLDivElement | null = null;
  tabsContainer: HTMLDivElement | null = null;
  buttonsContainer: HTMLDivElement | null = null;
  collapseIndicator: HTMLSpanElement | null = null;
}
export const states = new States();
