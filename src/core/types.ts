export interface TaskSelectorManagerAPI {
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

export interface BiliSelectScriptAPI_Interface {
  selectVideoCardByBv: (
    bvId: string,
    select: boolean,
    originatingFromTaskManager?: boolean,
    originMediaId?: string | null,
  ) => void;
  isBvSelected: (bvId: string) => boolean;
}

export interface CustomWindow extends Window {
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
// --- TypeScript Type Definitions ---
interface GmXhrHandle {
  abort: () => void;
}
// REPLACE THE OLD DECLARATION WITH THIS CORRECTED ONE
declare global {
  const GM_xmlhttpRequest: (details: any) => GmXhrHandle;
  const unsafeWindow: CustomWindow;
}

export {};
