interface BasicTask {
  name: string; // part name
  bv: string; // bvId of the parent video
}
// In TaskSelectScript
export interface Task extends BasicTask {
  // Represents a Sub-Task (分P)
  id: string; // cid
}

export interface ParentTask extends BasicTask {
  children: Task[];
  isExpanded: boolean; // UI state for collapsing
  MediaId: string;
}

export interface TabData {
  name: string;
  tasks: ParentTask[]; // NEW: List of parent tasks
}

export interface SelectedTask extends Task {
  marked: boolean;
}

// Define the structure for our flattened list
export interface FlatTaskItem {
  type: "parent" | "child";
  data: ParentTask | Task;
  parent?: ParentTask; // For child tasks
  top: number;
  height: number;
}

export interface TabState {
  taskScrollTop: number;
  tabScrollLeft: number;
  needsRender: boolean;
  lastRenderedScrollTop: number;
  // ADD THIS
  flatListCache?: FlatTaskItem[];
  // ADD THIS
  needsCacheUpdate?: boolean;
}

export interface WindowUiState {
  collapsed: boolean;
  top: string;
  left: string;
  width: string;
  height: string;
}

// MODIFIED
export type TaskDownloadStatus =
  | "pending"
  | "downloading"
  | "retrying"
  | "completed"
  | "failed"
  | "restarted";

export interface ProgressTaskItem extends SelectedTask {
  progress: number;
  windowId: string;
  status: TaskDownloadStatus; // 新增字段
}

export interface ProgressWindowState {
  id: string;
  top: string;
  left: string;
  width: string;
  height: string;
  scrollTop: number;
  needsRender: boolean;
  lastRenderedScrollTop: number;
}

export interface ProgressWindowData {
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
