import { states } from "./states";
import { renderTasksForCurrentTab } from "./render";
import { findChildTaskByIdGlobal } from "./utils";
import { TaskSelectorManager } from "./utils";
import { SelectedTask } from "./types";
import { updateTaskStateById } from "./utils";
import { download } from "./download";
import { scheduleTick } from "./render";

function updateSelectionBoxVisuals(): void {
  if (
    !states.selectionBoxElement ||
    !states.taskListContainer ||
    !states.startContainerRect
  )
    return;

  const anchorYInContainer =
    states.selectionBoxStart.y -
    states.startContainerRect.top +
    states.startScrollTop;
  const anchorXInContainer =
    states.selectionBoxStart.x - states.startContainerRect.left;

  const currentContainerRect = states.taskListContainer.getBoundingClientRect();
  const activeYInContainer =
    states.lastClientY -
    currentContainerRect.top +
    states.taskListContainer.scrollTop;
  const activeXInContainer = states.lastClientX - currentContainerRect.left;

  const finalTop = Math.min(anchorYInContainer, activeYInContainer);
  const finalLeft = Math.min(anchorXInContainer, activeXInContainer);
  const finalHeight = Math.abs(anchorYInContainer - activeYInContainer);
  const finalWidth = Math.abs(anchorXInContainer - activeXInContainer);

  Object.assign(states.selectionBoxElement.style, {
    top: `${finalTop}px`,
    left: `${finalLeft}px`,
    height: `${finalHeight}px`,
    width: `${finalWidth}px`,
  });
}

function isAnyTaskSelectedForBvInPreview(bvId: string): boolean {
  if (!bvId) return false;
  for (const taskId of states.previewSelectedTaskIds) {
    const taskData = states.taskMap.get(taskId);
    if (taskData && taskData.bv === bvId) return true;
  }
  return false;
}

function updateSelectionFromBox(isFinal: boolean = false): void {
  if (!states.selectionBoxElement || !states.taskListContainer) return;

  if (isFinal) {
    const oldSelectedIds = new Set(states.selectedTaskIds);
    states.selectedTaskIds = states.previewSelectedTaskIds;
    states.previewSelectedTaskIds = new Set();
    const affectedBvIds = new Set<string>();
    const allInvolvedIds = new Set([
      ...oldSelectedIds,
      ...states.selectedTaskIds,
    ]);
    allInvolvedIds.forEach((id) => {
      const task = findChildTaskByIdGlobal(id);
      if (task) affectedBvIds.add(task.bv);
    });
    renderTasksForCurrentTab(true);
    if (unsafeWindow.BiliSelectScriptAPI) {
      affectedBvIds.forEach((bvIdToUpdate) => {
        const shouldBeSelectedInBili =
          TaskSelectorManager.isAnyTaskSelectedForBv(bvIdToUpdate);
        unsafeWindow.BiliSelectScriptAPI!.selectVideoCardByBv(
          bvIdToUpdate,
          shouldBeSelectedInBili,
          true,
        );
      });
    }
  } else {
    const boxRectVP = states.selectionBoxElement.getBoundingClientRect();
    const childTaskItems =
      states.taskListContainer.querySelectorAll<HTMLDivElement>(
        ".task-selector-child-task",
      );
    childTaskItems.forEach((item) => {
      const taskId = item.dataset.taskId;
      if (!taskId || states.markedTaskIds.has(taskId)) return;
      const wasPreviouslyIntersecting =
        states.lastIntersectionStatePerTask.get(taskId) ?? false;
      const itemRectVP = item.getBoundingClientRect();
      const isCurrentlyIntersecting = !(
        itemRectVP.right < boxRectVP.left ||
        itemRectVP.left > boxRectVP.right ||
        itemRectVP.bottom < boxRectVP.top ||
        itemRectVP.top > boxRectVP.bottom
      );
      if (isCurrentlyIntersecting !== wasPreviouslyIntersecting) {
        if (states.previewSelectedTaskIds.has(taskId)) {
          states.previewSelectedTaskIds.delete(taskId);
        } else {
          states.previewSelectedTaskIds.add(taskId);
        }
        item.classList.toggle("selected");
        const parentBvId = item.dataset.bv;
        if (parentBvId && unsafeWindow.BiliSelectScriptAPI) {
          const shouldParentBeSelected =
            isAnyTaskSelectedForBvInPreview(parentBvId);
          unsafeWindow.BiliSelectScriptAPI.selectVideoCardByBv(
            parentBvId,
            shouldParentBeSelected,
            true,
          );
        }
      }
      states.lastIntersectionStatePerTask.set(taskId, isCurrentlyIntersecting);
    });
  }
}

export function toggleCollapse(event: MouseEvent): void {
  event.stopPropagation();
  const sCollapse = !states.windowState.collapsed;
  if (!states.container || !states.collapseIndicator) return;
  if (sCollapse) {
    if (!states.windowState.collapsed) {
      states.windowState.width = states.container.offsetWidth + "px";
      states.windowState.height = states.container.offsetHeight + "px";
    }
    states.container.classList.add("collapsed");
    states.collapseIndicator.textContent = "+";
    states.container.style.cursor = "grab";
  } else {
    states.container.classList.remove("collapsed");
    states.collapseIndicator.textContent = "−";
    states.container.style.cursor = "";
    if (states.header) states.header.style.cursor = "grab";
    states.container.style.width = states.windowState.width || "350px";
    states.container.style.height = states.windowState.height || "450px";
    requestAnimationFrame(() => {
      if (states.currentTabId && states.tabStates[states.currentTabId]) {
        states.tabStates[states.currentTabId].needsRender = true;
        states.tabStates[states.currentTabId].lastRenderedScrollTop = -1;
      }
      renderTasksForCurrentTab(true);
      if (states.tabsContainer) {
        states.tabsContainer.scrollLeft =
          (states.currentTabId &&
            states.tabStates[states.currentTabId]?.tabScrollLeft) ||
          0;
      }
    });
  }
  states.windowState.collapsed = sCollapse;
}

function tickSelectionBox(): void {
  if (!states.isSelectingBox) return;

  let canScrollDown = true;
  if (
    states.autoScrollDirection > 0 &&
    states.taskListContainer &&
    states.selectionBoxElement
  ) {
    const state = states.currentTabId
      ? states.tabStates[states.currentTabId]
      : null;
    const flatItems = state?.flatListCache;
    if (flatItems && flatItems.length > 0) {
      const lastTaskItem = flatItems[flatItems.length - 1];
      const lastTaskBottomY = lastTaskItem.top + lastTaskItem.height;
      const selectionBoxBottomY =
        states.selectionBoxElement.offsetTop +
        states.selectionBoxElement.offsetHeight;
      if (selectionBoxBottomY >= lastTaskBottomY) {
        canScrollDown = false;
        const containerHeight = states.taskListContainer.clientHeight;
        const targetScrollTop = lastTaskBottomY - containerHeight + 5;
        if (states.taskListContainer.scrollTop < targetScrollTop) {
          states.taskListContainer.scrollTop = targetScrollTop;
        }
      }
    }
  }

  if (states.autoScrollDirection !== 0 && states.taskListContainer) {
    if (!(states.autoScrollDirection > 0 && !canScrollDown)) {
      states.taskListContainer.scrollTop +=
        states.AUTO_SCROLL_SPEED_MAX * states.autoScrollDirection;
    }
  }

  updateSelectionBoxVisuals();
  updateSelectionFromBox(false);
  requestAnimationFrame(tickSelectionBox);
}

export function handleMouseDownTaskList(event: PointerEvent): void {
  if ((event.target as HTMLElement).closest(".task-selector-task-item")) return;
  const containerRect = states.taskListContainer?.getBoundingClientRect();
  if (
    !containerRect ||
    !states.taskListContainer ||
    event.clientX > containerRect.right - 15
  )
    return;
  event.preventDefault();

  try {
    states.taskListContainer.setPointerCapture(event.pointerId);
  } catch (error) {
    console.warn("setPointerCapture failed.", error);
  }

  states.taskListContainer.querySelector(".task-selection-box")?.remove();
  states.selectionBoxElement = document.createElement("div");
  states.selectionBoxElement.className = "task-selection-box";
  states.taskListContainer.appendChild(states.selectionBoxElement);
  states.isSelectingBox = true;
  states.previewSelectedTaskIds = new Set(states.selectedTaskIds);
  states.lastIntersectionStatePerTask.clear();
  states.selectionBoxStart = { x: event.clientX, y: event.clientY };
  states.lastClientX = event.clientX;
  states.lastClientY = event.clientY;
  states.startScrollTop = states.taskListContainer.scrollTop;
  states.startContainerRect = containerRect;
  Object.assign(states.selectionBoxElement.style, { display: "block" });
  document.addEventListener("pointermove", handleMouseMoveSelectBox, {
    passive: false,
  });
  document.addEventListener("pointerup", handleMouseUpSelectBox);
  document.body.style.userSelect = "none";
  requestAnimationFrame(tickSelectionBox);
}

export function handleMouseMoveSelectBox(event: PointerEvent): void {
  if (!states.isSelectingBox || !states.taskListContainer) return;
  event.preventDefault();
  const containerRect = states.taskListContainer.getBoundingClientRect();
  states.lastClientX = Math.max(
    containerRect.left,
    Math.min(event.clientX, containerRect.right),
  );
  states.lastClientY = Math.max(
    containerRect.top,
    Math.min(event.clientY, containerRect.bottom),
  );
  let scrollDirection = 0;
  if (states.lastClientY <= containerRect.top + states.AUTO_SCROLL_ZONE_SIZE)
    scrollDirection = -1;
  else if (
    states.lastClientY >=
    containerRect.bottom - states.AUTO_SCROLL_ZONE_SIZE
  )
    scrollDirection = 1;
  states.autoScrollDirection = scrollDirection;
}

export function handleMouseUpSelectBox(event: PointerEvent): void {
  if (!states.isSelectingBox) return;
  if (states.taskListContainer) {
    try {
      states.taskListContainer.releasePointerCapture(event.pointerId);
    } catch (error) {
      console.warn("releasePointerCapture failed.", error);
    }
  }
  states.isSelectingBox = false;
  states.autoScrollDirection = 0;
  try {
    updateSelectionFromBox(true);
  } catch (error) {
    console.error(
      "Error during final updateSelectionFromBox in mouseup:",
      error,
    );
  } finally {
    states.selectionBoxElement?.remove();
    states.selectionBoxElement = null;
    document.removeEventListener("pointermove", handleMouseMoveSelectBox);
    document.removeEventListener("pointerup", handleMouseUpSelectBox);
    document.body.style.userSelect = "";
    states.lastIntersectionStatePerTask.clear();
    states.startContainerRect = null;
    states.startScrollTop = 0;
  }
}

export function handleConnectionLost(): void {
  if (states.activeDownloads.size === 0) return;
  for (const [_taskId, handle] of states.activeDownloads.entries()) {
    handle.abort();
  }
  states.activeDownloads.clear();
}

export async function handleConnectionRestored(): Promise<void> {
  let totalRestartedCount = 0;
  for (const windowId in states.progressWindows) {
    const pwData = states.progressWindows[windowId];
    if (!pwData) continue;
    const tasksToRestartInWindow = pwData.tasks.filter(
      (t) => t.status === "failed",
    );
    if (tasksToRestartInWindow.length === 0) continue;
    totalRestartedCount += tasksToRestartInWindow.length;
    const tasksForDownload: Record<string, SelectedTask> = {};
    tasksToRestartInWindow.forEach((task) => {
      updateTaskStateById(windowId, task.id, {
        status: "pending",
        progress: 0,
      });
      tasksForDownload[task.id] = {
        id: task.id,
        name: task.name,
        bv: task.bv,
        marked: true,
      };
    });
    download(tasksForDownload, windowId).catch((_error) => {
      tasksToRestartInWindow.forEach((task) => {
        updateTaskStateById(windowId, task.id, {
          status: "failed",
          progress: 0,
        });
      });
    });
  }
  if (totalRestartedCount > 0) {
    alert(
      `网络已恢复, 已在现有窗口中尝试重新启动 ${totalRestartedCount} 个失败的任务。`,
    );
  }
}

export function handleTaskListScroll(): void {
  if (
    !states.taskListContainer ||
    !states.currentTabId ||
    !states.tabStates[states.currentTabId]
  )
    return;
  const state = states.tabStates[states.currentTabId];
  state.taskScrollTop = states.taskListContainer.scrollTop;
  state.needsRender = true;
  scheduleTick();
}

export function handleTabsScroll(): void {
  if (
    !states.tabsContainer ||
    !states.currentTabId ||
    !states.tabStates[states.currentTabId]
  )
    return;
  states.tabStates[states.currentTabId].tabScrollLeft =
    states.tabsContainer.scrollLeft;
}