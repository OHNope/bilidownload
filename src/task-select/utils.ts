import { ProgressTaskItem } from "./types";
import { states } from "./states";
import { TaskSelectorManagerAPI } from "../core/types";
import { ParentTask, Task } from "./types";
import { renderTabs, scheduleTick } from "./render";
import { closeProgressWindow } from "./ui";

export function updateTaskStateById(
  windowId: string,
  taskId: string,
  newState: Partial<Pick<ProgressTaskItem, "progress" | "status">>,
): void {
  const pw = states.progressWindows[windowId];
  if (!pw) return;
  const taskItem = pw.tasks.find((t) => t.id === taskId);
  if (taskItem) {
    if (newState.progress !== undefined)
      taskItem.progress = Math.max(0, Math.min(100, newState.progress));
    if (newState.status !== undefined) taskItem.status = newState.status;
    const itemNode = pw.listElement?.querySelector<HTMLDivElement>(
      `.task-progress-item[data-task-id="${taskId}"]`,
    );
    if (itemNode) {
      const progressBar =
        itemNode.querySelector<HTMLDivElement>(".task-progress-bar");
      if (progressBar) {
        progressBar.style.width = `${taskItem.progress}%`;
        progressBar.className = "task-progress-bar";
        progressBar.classList.add(`status-${taskItem.status}`);
      }
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
          itemNode
            .querySelector(".task-progress-item-name")
            ?.appendChild(statusTextElem);
        }
        let text = "";
        if (taskItem.status === "retrying") text = " (重试中...)";
        if (taskItem.status === "failed") text = " (下载失败)";
        if (taskItem.status === "restarted") text = " (已在新批次中重启)";
        statusTextElem.textContent = text;
      } else if (statusTextElem) {
        statusTextElem.textContent = "";
      }
    }
    if (newState.status === "completed" || newState.status === "failed") {
      pw.checkCompletion();
    }
  }
}
export const TaskSelectorManager: TaskSelectorManagerAPI = {
  addTaskData: (
    tabId,
    tabName,
    parentTaskInputs,
    autoSelectNewChildren = false,
  ) => {
    if (!tabId || !tabName || !Array.isArray(parentTaskInputs)) return;
    const sId = String(tabId);
    let needsReRenderCurrentTab = false,
      tabCreated = false;
    if (!states.allTasksData[sId]) {
      states.allTasksData[sId] = { name: tabName, tasks: [] };
      states.tabStates[sId] = {
        taskScrollTop: 0,
        tabScrollLeft: 0,
        needsRender: false,
        lastRenderedScrollTop: -1,
      };
      tabCreated = true;
      if (!states.currentTabId) states.currentTabId = sId;
    }
    const tabParentTasks = states.allTasksData[sId].tasks;
    parentTaskInputs.forEach((videoInput) => {
      const existingParentTask = tabParentTasks.find(
        (pt) => pt.bv === videoInput.bvId,
      );
      if (existingParentTask) {
        if (autoSelectNewChildren) {
          existingParentTask.children.forEach((childTask) => {
            if (!states.markedTaskIds.has(childTask.id)) {
              states.selectedTaskIds.add(childTask.id);
              needsReRenderCurrentTab = true;
            }
          });
        }
        return;
      }
      const children: Task[] = videoInput.pages.map((page) => ({
        id: String(page.cid),
        name: String(page.part),
        bv: videoInput.bvId,
      }));
      if (children.length === 0) return;
      children.forEach((child) => states.taskMap.set(child.id, child));
      const newParentTask: ParentTask = {
        name: videoInput.videoTitle,
        bv: videoInput.bvId,
        children,
        isExpanded: true,
        MediaId: tabId,
      };
      tabParentTasks.push(newParentTask);
      needsReRenderCurrentTab = true;
      if (autoSelectNewChildren) {
        newParentTask.children.forEach((childTask) =>
          states.selectedTaskIds.add(childTask.id),
        );
      }
    });
    if (tabCreated && states.tabsContainer) renderTabs();
    if (
      needsReRenderCurrentTab &&
      sId === states.currentTabId &&
      !states.windowState.collapsed &&
      states.taskListContainer
    ) {
      if (states.tabStates[sId]) {
        states.tabStates[sId].needsCacheUpdate = true;
        states.tabStates[sId].needsRender = true;
        states.tabStates[sId].lastRenderedScrollTop = -1;
      }
      scheduleTick();
    }
  },
  updateTaskProgress: (wId, tId, p) =>
    states.progressWindows[String(wId)]?.updateProgress(String(tId), p),
  getSelectedTaskIds: () => Array.from(states.selectedTaskIds),
  isTaskSelected: (taskId) => states.selectedTaskIds.has(taskId),
  isAnyTaskSelectedForBv: (bvId) => {
    if (!bvId) return false;
    for (const taskId of states.selectedTaskIds) {
      const taskData = findChildTaskByIdGlobal(taskId);
      if (taskData && taskData.bv === bvId) return true;
    }
    return false;
  },
  destroy: () => {
    if (!states.container) return;
    states.globalCleanupFunctions.forEach((cleanup) => cleanup());
    states.globalCleanupFunctions.length = 0;
    Object.keys(states.progressWindows).forEach(closeProgressWindow);
    states.container.remove();
    document.getElementById("task-selector-styles")?.remove();
    states.allTasksData = {};
    states.selectedTaskIds = new Set<string>();
    states.markedTaskIds = new Set<string>();
    states.taskMap = new Map<string, Task>();
    states.activeDownloads.clear();
    states.currentTabId = null;
    states.tabStates = {};
    states.windowState = {
      collapsed: true,
      top: "20px",
      left: "20px",
      width: "350px",
      height: "450px",
    };
    states.progressWindows = {};
    states.progressWindowCounter = 0;
    states.isSelectingBox = false;
    states.selectionBoxStart = { x: 0, y: 0 };
    states.tickScheduled = false;
    states.container = null;
    states.header = null;
    states.body = null;
    states.taskListContainer = null;
    states.tabsContainer = null;
    states.buttonsContainer = null;
    states.collapseIndicator = null;
    states.selectionBoxElement = null;
    delete unsafeWindow.TaskSelectorManager;
  },
  selectTasksByBv: (bvId, shouldSelect) => {
    if (!bvId) return;
    let changed = false,
      affectsCurrentTab = false;
    for (const tabId in states.allTasksData) {
      const parentTask = states.allTasksData[tabId].tasks.find(
        (pt) => pt.bv === bvId,
      );
      if (parentTask) {
        parentTask.children.forEach((child) => {
          const childId = child.id;
          if (shouldSelect) {
            if (
              !states.selectedTaskIds.has(childId) &&
              !states.markedTaskIds.has(childId)
            ) {
              states.selectedTaskIds.add(childId);
              changed = true;
            }
          } else {
            if (states.selectedTaskIds.has(childId)) {
              states.selectedTaskIds.delete(childId);
              changed = true;
            }
          }
        });
        if (changed && tabId === states.currentTabId) affectsCurrentTab = true;
      }
    }
    if (changed && affectsCurrentTab) {
      if (
        states.tabStates[states.currentTabId!] &&
        !states.windowState.collapsed &&
        states.taskListContainer
      ) {
        states.tabStates[states.currentTabId!].needsRender = true;
        states.tabStates[states.currentTabId!].lastRenderedScrollTop = -1;
        scheduleTick();
      }
    }
  },
};

export function findChildTaskByIdGlobal(childId: string): Task | null {
  return states.taskMap.get(childId) || null;
}
