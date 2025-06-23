import { TaskSelectorManagerAPI } from "../types";
import { download } from "./download";
import { updateTaskStateById } from "./utils";
import { states } from "./states";
import {
  TabData,
  ParentTask,
  Task,
  FlatTaskItem,
  SelectedTask,
  ProgressWindowState,
  ProgressTaskItem,
} from "./types";

export function TaskSelectScript(): void {
  // --- 防止重复注入 ---
  if (unsafeWindow.TaskSelectorManager) {
    console.log(
      "Task Selector Manager already injected. Destroying previous instance.",
    );
    unsafeWindow.TaskSelectorManager.destroy?.();
  }
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
      timeout = unsafeWindow.setTimeout(later, wait);
    };
  }

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

    const currentContainerRect =
      states.taskListContainer.getBoundingClientRect();
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

  function createDragHandler(options: {
    triggerElement: HTMLElement;
    movableElement: HTMLElement;
    state: { top: string; left: string };
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
        Math.min(
          newTop,
          unsafeWindow.innerHeight - movableElement.offsetHeight,
        ),
      );
      newLeft = Math.max(
        0,
        Math.min(newLeft, unsafeWindow.innerWidth - movableElement.offsetWidth),
      );
      movableElement.style.top = `${newTop}px`;
      movableElement.style.left = `${newLeft}px`;
    };

    const handleMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
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
    return () => {
      triggerElement.removeEventListener("mousedown", handleMouseDown);
    };
  }

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
      .task-selector-task-list-container { flex-grow: 1; overflow-y: auto; overflow-x: hidden; position: relative; -ms-overflow-style: none; scrollbar-width: thin; }
      .task-selector-task-list-container::-webkit-scrollbar { width: 8px; }
      .task-selector-task-list-container::-webkit-scrollbar-thumb { background-color: #c1c1c1; border-radius: 4px; }
      .task-selector-task-item { padding: 5px 8px; margin: 0; background-color: #fff; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; transition: background-color 0.1s ease, border-color 0.1s ease; position: absolute; top: 0; left: 5px; right: 5px; box-sizing: border-box; height: ${states.TASK_ITEM_HEIGHT - 12}px; }
      .virtual-scroll-spacer { position: absolute; top: 0; left: 0; width: 1px; height: 0; z-index: -1; }
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
      .task-progress-unsafeWindow { position: fixed; z-index: 9998; background-color: rgba(255, 255, 255, 0.98); border: 1px solid #bbb; box-shadow: 0 3px 9px rgba(0,0,0,0.15); display: flex; flex-direction: column; overflow: hidden; user-select: none; color: #333; font-family: sans-serif; min-width: 200px; min-height: 100px; }
      .task-progress-header { padding: 5px 8px; background-color: #f0f0f0; cursor: grab; border-bottom: 1px solid #ccc; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; min-height: 26px; }
      .task-progress-header:active { cursor: grabbing; }
      .task-progress-title { font-weight: bold; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-right: 10px; }
      .task-progress-close-btn { background: #ffcccc; border: 1px solid #ffaaaa; color: #a00; border-radius: 50%; width: 18px; height: 18px; line-height: 16px; text-align: center; cursor: pointer; font-weight: bold; display: none; font-size: 12px; flex-shrink: 0; }
      .task-progress-close-btn.visible { display: block; }
      .task-progress-list-container { flex-grow: 1; overflow-y: auto; padding: 8px 0; scrollbar-width: none; -ms-overflow-style: none; position: relative; }
      .task-progress-list-container::-webkit-scrollbar { display: none; }
      .task-progress-item { padding: 5px 8px; border: 1px solid #eee; border-radius: 3px; background-color: #f9f9f9; display: flex; flex-direction: column; position: absolute; left: 8px; right: 8px; height: ${states.PROGRESS_ITEM_HEIGHT}px; box-sizing: border-box; }
      .task-progress-item-name { font-size: 12px; margin-bottom: 4px; white-space: normal; word-break: break-word; }
      .task-progress-bar-container { height: 10px; background-color: #e0e0e0; border-radius: 5px; overflow: hidden; border: 1px solid #d0d0d0; flex-shrink: 0; margin-top: auto; }
      .task-progress-bar { height: 100%; width: 0%; background-color: #76c7c0; border-radius: 5px 0 0 5px; transition: width 0.3s ease-out, background-color 0.3s ease-in-out; }
      .task-progress-bar.status-retrying { background-color: #f0ad4e; }
      .task-progress-bar.status-restarted { background-color: #5bc0de; }
      .task-progress-bar.status-failed { background-color: #d9534f; width: 100% !important; }
      .task-progress-item-status-text { font-size: 10px; color: #888; margin-left: 8px; font-style: italic; }
      .task-progress-resizer { position: absolute; width: 12px; height: 12px; right: 0; bottom: 0; cursor: nwse-resize; z-index: 10; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; }
      .task-selector-parent-task { font-weight: bold; display: flex; align-items: center; }
      .task-selector-child-task {}
      .task-expander { display: inline-block; width: 1em; user-select: none; }
      .task-selector-task-item { padding: 5px 8px; box-sizing: border-box; }
  `;

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
    if (tabId === states.currentTabId) i.classList.add("active");
    i.addEventListener("click", handleTabClick as EventListener);
    i.setAttribute("draggable", "false");
    return i;
  }

  function toggleParentTaskExpansion(parentTask: ParentTask): void {
    parentTask.isExpanded = !parentTask.isExpanded;
    if (states.currentTabId && states.tabStates[states.currentTabId]) {
      states.tabStates[states.currentTabId].needsCacheUpdate = true;
      states.tabStates[states.currentTabId].needsRender = true;
      states.tabStates[states.currentTabId].lastRenderedScrollTop = -1;
      scheduleTick();
    }
  }

  function createParentTaskNode(parentTask: ParentTask): HTMLDivElement {
    const pItem = document.createElement("div");
    pItem.className = "task-selector-task-item task-selector-parent-task";
    pItem.dataset.bvId = parentTask.bv;
    pItem.style.height = `${states.PARENT_TASK_ITEM_HEIGHT}px`;

    const expander = document.createElement("span");
    expander.className = "task-expander";
    expander.textContent = parentTask.isExpanded ? "▼ " : "▶ ";
    expander.style.marginRight = "5px";
    expander.style.cursor = "pointer";
    expander.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleParentTaskExpansion(parentTask);
    });

    const titleSpan = document.createElement("span");
    titleSpan.textContent = parentTask.name;
    titleSpan.title = parentTask.name;
    titleSpan.style.flexGrow = "1";
    titleSpan.style.cursor = "pointer";
    titleSpan.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleParentTaskExpansion(parentTask);
    });

    pItem.setAttribute("draggable", "false");
    pItem.append(expander, titleSpan);
    return pItem;
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
    i.dataset.taskId = task.id;
    i.dataset.mediaId = MediaId;
    i.dataset.bv = parentBvId;
    i.style.height = `${states.CHILD_TASK_ITEM_HEIGHT}px`;
    i.style.marginLeft = "20px";

    if (states.markedTaskIds.has(task.id)) {
      i.classList.add("marked");
    } else if (states.isSelectingBox) {
      if (states.previewSelectedTaskIds.has(task.id)) {
        i.classList.add("selected");
      }
    } else {
      if (states.selectedTaskIds.has(task.id)) {
        i.classList.add("selected");
      }
    }

    i.addEventListener("click", handleChildTaskClick as EventListener);
    i.setAttribute("draggable", "false");
    return i;
  }

  function renderTabs(): void {
    if (!states.tabsContainer) return;
    states.tabsContainer.innerHTML = "";
    const tIds = Object.keys(states.allTasksData);
    if (tIds.length === 0) return;
    tIds.forEach((tid) =>
      states.tabsContainer!.appendChild(
        createTabItemNode(tid, states.allTasksData[tid]),
      ),
    );
    if (
      states.currentTabId &&
      states.tabStates[states.currentTabId]?.tabScrollLeft
    ) {
      states.tabsContainer.scrollLeft =
        states.tabStates[states.currentTabId].tabScrollLeft;
    } else {
      states.tabsContainer.scrollLeft = 0;
    }
    if (!states.currentTabId && tIds.length > 0) states.currentTabId = tIds[0];
    if (
      states.currentTabId &&
      !states.allTasksData[states.currentTabId] &&
      tIds.length > 0
    ) {
      states.currentTabId = tIds[0];
    }
    const aTab = states.currentTabId
      ? states.tabsContainer.querySelector<HTMLDivElement>(
          `.task-selector-tab-item[data-tab-id="${states.currentTabId}"]`,
        )
      : null;
    if (aTab) {
      aTab.classList.add("active");
    } else if (states.tabsContainer.firstChild) {
      (states.tabsContainer.firstChild as HTMLElement).classList.add("active");
      states.currentTabId = (
        states.tabsContainer.firstChild as HTMLElement
      ).dataset.tabId!;
    }
  }

  function renderTasksForCurrentTab(forceUpdate: boolean = false): void {
    const state = states.currentTabId
      ? states.tabStates[states.currentTabId]
      : null;
    if (
      !states.currentTabId ||
      !states.allTasksData[states.currentTabId] ||
      !states.taskListContainer ||
      !state
    ) {
      if (states.taskListContainer) {
        const spacer = states.taskListContainer.querySelector(
          ".virtual-scroll-spacer",
        );
        states.taskListContainer.innerHTML = "";
        if (spacer) states.taskListContainer.appendChild(spacer);
      }
      if (state) state.lastRenderedScrollTop = -1;
      return;
    }

    const scrollTop = states.taskListContainer.scrollTop;
    const containerHeight = states.taskListContainer.clientHeight;
    state.taskScrollTop = scrollTop;

    if (containerHeight <= 0 && !forceUpdate) return;

    if (state.needsCacheUpdate || !state.flatListCache) {
      const flatItems: FlatTaskItem[] = [];
      let currentY = 5;
      states.allTasksData[states.currentTabId].tasks.forEach((parentTask) => {
        flatItems.push({
          type: "parent",
          data: parentTask,
          top: currentY,
          height: states.PARENT_TASK_ITEM_HEIGHT,
        });
        currentY += states.PARENT_TASK_ITEM_HEIGHT;
        if (parentTask.isExpanded) {
          parentTask.children.forEach((childTask) => {
            flatItems.push({
              type: "child",
              data: childTask,
              parent: parentTask,
              top: currentY,
              height: states.CHILD_TASK_ITEM_HEIGHT,
            });
            currentY += states.CHILD_TASK_ITEM_HEIGHT;
          });
        }
      });
      state.flatListCache = flatItems;
      state.needsCacheUpdate = false;
    }

    const flatItems = state.flatListCache!;
    const totalHeight =
      flatItems.length > 0
        ? flatItems[flatItems.length - 1].top +
          flatItems[flatItems.length - 1].height +
          5
        : 10;
    const spacer = states.taskListContainer.querySelector(
      ".virtual-scroll-spacer",
    ) as HTMLDivElement;
    if (spacer) spacer.style.height = `${totalHeight}px`;

    const buffer = 10;
    let startIndex = flatItems.findIndex(
      (item) => item.top + item.height > scrollTop,
    );
    let endIndex = flatItems.findIndex(
      (item) => item.top > scrollTop + containerHeight,
    );
    startIndex = Math.max(0, startIndex - buffer);
    endIndex =
      endIndex === -1
        ? flatItems.length
        : Math.min(flatItems.length, endIndex + buffer);

    const fragment = document.createDocumentFragment();
    const itemsToRender = flatItems.slice(startIndex, endIndex);
    itemsToRender.forEach((item) => {
      let node: HTMLDivElement;
      if (item.type === "parent") {
        node = createParentTaskNode(item.data as ParentTask);
      } else {
        const childData = item.data as Task;
        const parentData = item.parent!;
        node = createChildTaskNode(
          childData,
          parentData.bv,
          parentData.MediaId,
        );
      }
      node.style.transform = `translateY(${item.top}px)`;
      fragment.appendChild(node);
    });

    const existingItems = states.taskListContainer.querySelectorAll(
      ".task-selector-task-item",
    );
    existingItems.forEach((item) => item.remove());
    states.taskListContainer.appendChild(fragment);
    state.lastRenderedScrollTop = scrollTop;
    state.needsRender = false;

    if (forceUpdate) {
      const forcedScrollTop = state.taskScrollTop ?? 0;
      requestAnimationFrame(() => {
        if (states.taskListContainer)
          states.taskListContainer.scrollTop = forcedScrollTop;
      });
    }
  }

  function scheduleTick(): void {
    if (!states.tickScheduled) {
      states.tickScheduled = true;
      requestAnimationFrame(tick);
    }
  }

  function tick(): void {
    states.tickScheduled = false;
    if (
      states.taskListContainer &&
      !states.windowState.collapsed &&
      states.currentTabId &&
      states.tabStates[states.currentTabId]?.needsRender
    ) {
      const state = states.tabStates[states.currentTabId];
      if (
        state.lastRenderedScrollTop === -1 ||
        Math.abs(state.taskScrollTop - state.lastRenderedScrollTop) >
          states.SCROLL_RENDER_THRESHOLD
      ) {
        renderTasksForCurrentTab();
      } else {
        state.needsRender = false;
      }
    }
    for (const windowId in states.progressWindows) {
      const pwData = states.progressWindows[windowId];
      const pwState = pwData?.state;
      if (pwData?.listElement && pwState?.needsRender) {
        if (
          pwState.lastRenderedScrollTop === -1 ||
          Math.abs(pwState.scrollTop - pwState.lastRenderedScrollTop) >
            states.SCROLL_RENDER_THRESHOLD
        ) {
          renderProgressItems(windowId);
        } else {
          pwState.needsRender = false;
        }
      }
    }
  }

  function handleConnectionLost(): void {
    if (states.activeDownloads.size === 0) return;
    for (const [_taskId, handle] of states.activeDownloads.entries()) {
      handle.abort();
    }
    states.activeDownloads.clear();
  }

  async function handleConnectionRestored(): Promise<void> {
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

  function handleTabClick(event: MouseEvent): void {
    event.stopPropagation();
    const target = event.target as HTMLElement;
    const nId = target.dataset.tabId;
    if (!nId || nId === states.currentTabId) return;
    if (
      states.currentTabId &&
      states.tabStates[states.currentTabId] &&
      states.taskListContainer &&
      states.tabsContainer
    ) {
      states.tabStates[states.currentTabId].taskScrollTop =
        states.taskListContainer.scrollTop;
      states.tabStates[states.currentTabId].tabScrollLeft =
        states.tabsContainer.scrollLeft;
    }
    states.currentTabId = nId;
    states
      .tabsContainer!.querySelectorAll(".task-selector-tab-item.active")
      .forEach((el) => el.classList.remove("active"));
    target.classList.add("active");
    if (!states.tabStates[states.currentTabId]) {
      states.tabStates[states.currentTabId] = {
        taskScrollTop: 0,
        tabScrollLeft: 0,
        needsRender: false,
        lastRenderedScrollTop: -1,
      };
    }
    renderTasksForCurrentTab(true);
    if (states.tabsContainer) {
      requestAnimationFrame(() => {
        states.tabsContainer!.scrollLeft =
          states.tabStates[states.currentTabId!]?.tabScrollLeft || 0;
      });
    }
  }

  function toggleCollapse(event: MouseEvent): void {
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

  function handleMouseDownTaskList(event: PointerEvent): void {
    if ((event.target as HTMLElement).closest(".task-selector-task-item"))
      return;
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

  function handleMouseMoveSelectBox(event: PointerEvent): void {
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

  function handleMouseUpSelectBox(event: PointerEvent): void {
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

  function handleChildTaskClick(event: MouseEvent): void {
    event.stopPropagation();
    const targetItem = event.currentTarget as HTMLDivElement;
    const childTaskId = targetItem.dataset.taskId as string;
    const parentBvId = targetItem.dataset.bv as string;
    const parentMediaId = targetItem.dataset.mediaId as string;
    if (!childTaskId || !parentBvId || states.markedTaskIds.has(childTaskId))
      return;
    if (states.selectedTaskIds.has(childTaskId)) {
      states.selectedTaskIds.delete(childTaskId);
      targetItem.classList.remove("selected");
    } else {
      states.selectedTaskIds.add(childTaskId);
      targetItem.classList.add("selected");
    }
    if (unsafeWindow.BiliSelectScriptAPI) {
      const anyChildStillSelected =
        TaskSelectorManager.isAnyTaskSelectedForBv(parentBvId);
      unsafeWindow.BiliSelectScriptAPI.selectVideoCardByBv(
        parentBvId,
        anyChildStillSelected,
        true,
        parentMediaId,
      );
    }
  }

  function findChildTaskByIdGlobal(childId: string): Task | null {
    return states.taskMap.get(childId) || null;
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
        states.lastIntersectionStatePerTask.set(
          taskId,
          isCurrentlyIntersecting,
        );
      });
    }
  }

  function handleTaskListScroll(): void {
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

  function handleTabsScroll(): void {
    if (
      !states.tabsContainer ||
      !states.currentTabId ||
      !states.tabStates[states.currentTabId]
    )
      return;
    states.tabStates[states.currentTabId].tabScrollLeft =
      states.tabsContainer.scrollLeft;
  }
  const debouncedTabsScrollSave = debounce(handleTabsScroll, 150);

  function confirmSelection(): string | undefined {
    const tasksToProcess = Array.from(states.selectedTaskIds)
      .map((id) => findChildTaskByIdGlobal(id)!)
      .filter(Boolean);
    if (tasksToProcess.length === 0) return undefined;

    tasksToProcess.forEach((task) => {
      states.selectedTaskIds.delete(task.id);
      states.markedTaskIds.add(task.id);
    });

    const progressTasks = tasksToProcess.map((st) => ({
      id: st.id,
      name: st.name,
      bv: st.bv,
      marked: false,
    }));
    const nId = createProgressWindow(progressTasks);
    renderTasksForCurrentTab(true);

    const tasksForDownload: Record<string, SelectedTask> = {};
    states.markedTaskIds.forEach((id) => {
      const taskData = findChildTaskByIdGlobal(id);
      if (taskData) tasksForDownload[id] = { ...taskData, marked: true };
    });

    download(tasksForDownload, nId).catch((_err) => {
      alert("下载过程遭遇严重错误，已中断。详情请查看控制台。");
      closeProgressWindow(nId);
    });
    return nId;
  }

  function processVisibleTasks(
    action: (taskId: string, parentBvId: string) => boolean,
  ): void {
    if (!states.taskListContainer || states.windowState.collapsed) return;
    const containerRect = states.taskListContainer.getBoundingClientRect();
    const childTaskItems =
      states.taskListContainer.querySelectorAll<HTMLDivElement>(
        ".task-selector-child-task",
      );
    const affectedBvIds = new Set<string>();
    let changed = false;
    childTaskItems.forEach((item) => {
      const itemRect = item.getBoundingClientRect();
      const taskId = item.dataset.taskId,
        parentBvId = item.dataset.bv;
      if (!taskId || !parentBvId) return;
      if (
        itemRect.top < containerRect.bottom &&
        itemRect.bottom > containerRect.top
      ) {
        if (action(taskId, parentBvId)) {
          changed = true;
          affectedBvIds.add(parentBvId);
        }
      }
    });
    if (changed) {
      renderTasksForCurrentTab(true);
      if (unsafeWindow.BiliSelectScriptAPI) {
        affectedBvIds.forEach((bvId) => {
          unsafeWindow.BiliSelectScriptAPI!.selectVideoCardByBv(
            bvId,
            TaskSelectorManager.isAnyTaskSelectedForBv(bvId),
            true,
          );
        });
      }
    }
  }

  function selectVisibleTasks(): void {
    processVisibleTasks((taskId) => {
      if (
        !states.selectedTaskIds.has(taskId) &&
        !states.markedTaskIds.has(taskId)
      ) {
        states.selectedTaskIds.add(taskId);
        return true;
      }
      return false;
    });
  }

  function deselectVisibleTasks(): void {
    processVisibleTasks((taskId) => {
      if (states.selectedTaskIds.has(taskId)) {
        states.selectedTaskIds.delete(taskId);
        return true;
      }
      return false;
    });
  }

  function deselectAllTasks(): void {
    if (states.selectedTaskIds.size === 0) return;
    const bvsToUpdate = new Set<string>();
    for (const taskId of states.selectedTaskIds) {
      const taskData = states.taskMap.get(taskId);
      if (taskData) bvsToUpdate.add(taskData.bv);
    }
    states.selectedTaskIds.clear();
    renderTasksForCurrentTab(true);
    if (unsafeWindow.BiliSelectScriptAPI) {
      bvsToUpdate.forEach((bvId) =>
        unsafeWindow.BiliSelectScriptAPI!.selectVideoCardByBv(
          bvId,
          false,
          true,
        ),
      );
    }
  }

  function selectAllTasksInTab(): void {
    if (!states.currentTabId || !states.allTasksData[states.currentTabId])
      return;
    const parentTasksInCurrentTab =
      states.allTasksData[states.currentTabId].tasks;
    const bvsToUpdate = new Set<string>();
    let changed = false;
    parentTasksInCurrentTab.forEach((pt) => {
      pt.children.forEach((child) => {
        if (
          !states.selectedTaskIds.has(child.id) &&
          !states.markedTaskIds.has(child.id)
        ) {
          states.selectedTaskIds.add(child.id);
          changed = true;
        }
      });
      if (pt.children.length > 0) bvsToUpdate.add(pt.bv);
    });
    if (changed) {
      renderTasksForCurrentTab(true);
      if (unsafeWindow.BiliSelectScriptAPI) {
        bvsToUpdate.forEach((bvId) =>
          unsafeWindow.BiliSelectScriptAPI!.selectVideoCardByBv(
            bvId,
            true,
            true,
          ),
        );
      }
    }
  }

  function createProgressWindow(tasksForWindow: SelectedTask[]): string {
    states.progressWindowCounter++;
    const windowId = `progress-unsafeWindow-${states.progressWindowCounter}`;
    const preparedTasks: ProgressTaskItem[] = tasksForWindow.map((t) => ({
      ...t,
      progress: 0,
      windowId,
      status: "pending",
    }));
    const state: ProgressWindowState = {
      id: windowId,
      top: `${50 + states.progressWindowCounter * 15}px`,
      left: `${50 + states.progressWindowCounter * 15}px`,
      width: "300px",
      height: "250px",
      scrollTop: 0,
      needsRender: false,
      lastRenderedScrollTop: -1,
    };
    const pwC = document.createElement("div");
    pwC.id = windowId;
    pwC.className = "task-progress-unsafeWindow";
    Object.assign(pwC.style, {
      top: state.top,
      left: state.left,
      width: state.width,
      height: state.height,
    });
    const pwH = document.createElement("div");
    pwH.className = "task-progress-header";
    pwH.innerHTML = `<span class="task-progress-title">任务进度 (${preparedTasks.length})</span>`;
    const pwX = document.createElement("div");
    pwX.className = "task-progress-close-btn";
    pwX.textContent = "✕";
    pwX.addEventListener("click", (e) => {
      e.stopPropagation();
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
    cleanupFunctions.push(
      createDragHandler({ triggerElement: pwH, movableElement: pwC, state }),
    );
    cleanupFunctions.push(
      createResizeHandler({
        resizeHandleElement: pwR,
        resizableElement: pwC,
        state,
        onResize: () => {
          if (states.progressWindows[windowId]?.state)
            states.progressWindows[windowId].state.needsRender = true;
          scheduleTick();
        },
        onResizeEnd: () => {
          if (states.progressWindows[windowId]?.state) {
            states.progressWindows[windowId].state.needsRender = true;
            states.progressWindows[windowId].state.lastRenderedScrollTop = -1;
          }
          scheduleTick();
        },
      }),
    );
    states.progressWindows[windowId] = {
      element: pwC,
      listElement: pwL,
      closeButton: pwX,
      tasks: preparedTasks,
      state,
      checkCompletion: () => checkProgressCompletion(windowId),
      updateProgress: (tid, p) => updateTaskProgressById(windowId, tid, p),
      renderItems: (f = false) => renderProgressItems(windowId, f),
      handleScroll: () => handleProgressScroll(windowId),
      cleanupFunctions,
    };
    pwL.addEventListener(
      "scroll",
      states.progressWindows[windowId].handleScroll,
      { passive: true },
    );
    renderProgressItems(windowId, true);
    states.progressWindows[windowId].checkCompletion();
    return windowId;
  }

  function closeProgressWindow(windowId: string): void {
    const pw = states.progressWindows[windowId];
    if (!pw?.element) return;
    pw.cleanupFunctions.forEach((cleanup) => cleanup());
    pw.listElement?.removeEventListener("scroll", pw.handleScroll);
    pw.element.remove();
    delete states.progressWindows[windowId];
  }

  function updateTaskProgressById(wId: string, tId: string, p: number): void {
    updateTaskStateById(wId, tId, { progress: p });
  }

  function checkProgressCompletion(wId: string): void {
    const pw = states.progressWindows[wId];
    if (!pw?.closeButton) return;
    const allDone = pw.tasks.every(
      (t) => t.status === "completed" || t.status === "failed",
    );
    pw.closeButton.classList.toggle("visible", allDone);
  }

  function renderProgressItems(
    wId: string,
    forceUpdate: boolean = false,
  ): void {
    const pwData = states.progressWindows[wId];
    const pwState = pwData?.state;
    if (!pwData?.listElement || !pwState) return;
    const listContainer = pwData.listElement,
      scrollTop = listContainer.scrollTop,
      containerHeight = listContainer.clientHeight;
    pwState.scrollTop = scrollTop;
    if (containerHeight <= 0 && !forceUpdate) return;
    const tasks = pwData.tasks;
    const startIndex = Math.max(
      0,
      Math.floor(scrollTop / states.PROGRESS_ITEM_HEIGHT) -
        states.PROGRESS_VISIBLE_ITEMS_BUFFER,
    );
    const endIndex = Math.min(
      tasks.length,
      Math.ceil((scrollTop + containerHeight) / states.PROGRESS_ITEM_HEIGHT) +
        states.PROGRESS_VISIBLE_ITEMS_BUFFER,
    );
    const fragment = document.createDocumentFragment();
    listContainer.innerHTML = "";
    const spacer = document.createElement("div");
    spacer.style.cssText = `position:absolute;top:0;left:0;height:${tasks.length * states.PROGRESS_ITEM_HEIGHT}px;width:1px;z-index:-1;`;
    fragment.appendChild(spacer);
    for (let i = startIndex; i < endIndex; i++) {
      if (tasks[i]) {
        const t = tasks[i];
        const it = document.createElement("div");
        it.className = "task-progress-item";
        it.dataset.taskId = t.id;
        it.dataset.bv = t.bv;
        it.style.top = `${i * states.PROGRESS_ITEM_HEIGHT}px`;
        const nS = document.createElement("div");
        nS.className = "task-progress-item-name";
        nS.textContent = t.name;
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
        if (listContainer && states.progressWindows[wId]) {
          listContainer.scrollTop = forcedScrollTop;
          if (states.progressWindows[wId])
            states.progressWindows[wId].state.lastRenderedScrollTop =
              listContainer.scrollTop;
        }
      });
    }
  }

  function handleProgressScroll(windowId: string): void {
    const pwData = states.progressWindows[windowId];
    const pwState = pwData?.state;
    if (!pwData?.listElement || !pwState) return;
    pwState.scrollTop = pwData.listElement.scrollTop;
    pwState.needsRender = true;
    scheduleTick();
  }

  function isAnyTaskSelectedForBvInPreview(bvId: string): boolean {
    if (!bvId) return false;
    for (const taskId of states.previewSelectedTaskIds) {
      const taskData = states.taskMap.get(taskId);
      if (taskData && taskData.bv === bvId) return true;
    }
    return false;
  }

  function init(): void {
    if (states.container) return;
    injectStyles();
    states.container = document.createElement("div");
    states.container.className = "task-selector-container";
    states.container.setAttribute("draggable", "false");
    states.container.style.top = states.windowState.top;
    states.container.style.left = states.windowState.left;
    states.header = document.createElement("div");
    states.header.className = "task-selector-header";
    states.header.innerHTML =
      '<span class="task-selector-header-title">任务选择器</span>';
    states.collapseIndicator = document.createElement("span");
    states.collapseIndicator.className = "task-selector-collapse-indicator";
    states.header.appendChild(states.collapseIndicator);
    states.globalCleanupFunctions.push(
      createDragHandler({
        triggerElement: states.header,
        movableElement: states.container,
        state: states.windowState,
      }),
    );
    states.collapseIndicator.addEventListener(
      "click",
      toggleCollapse as EventListener,
    );
    states.body = document.createElement("div");
    states.body.className = "task-selector-body";
    states.buttonsContainer = document.createElement("div");
    states.buttonsContainer.className = "task-selector-buttons";
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
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        bi.action();
      });
      states.buttonsContainer!.appendChild(b);
    });
    const cW = document.createElement("div");
    cW.className = "task-selector-content-wrapper";
    states.taskListContainer = document.createElement("div");
    states.taskListContainer.className = "task-selector-task-list-container";
    states.taskListContainer.addEventListener("scroll", handleTaskListScroll, {
      passive: true,
    });
    states.taskListContainer.addEventListener(
      "pointerdown",
      handleMouseDownTaskList as EventListener,
    );
    const spacer = document.createElement("div");
    spacer.className = "virtual-scroll-spacer";
    states.taskListContainer.appendChild(spacer);
    states.tabsContainer = document.createElement("div");
    states.tabsContainer.className = "task-selector-tabs-container";
    states.tabsContainer.addEventListener("scroll", debouncedTabsScrollSave, {
      passive: true,
    });
    const rsz = document.createElement("div");
    rsz.className = "task-selector-resizer";
    states.globalCleanupFunctions.push(
      createResizeHandler({
        resizeHandleElement: rsz,
        resizableElement: states.container,
        state: states.windowState,
        onResize: () => {
          if (states.currentTabId && states.tabStates[states.currentTabId])
            states.tabStates[states.currentTabId].needsRender = true;
          scheduleTick();
        },
        onResizeEnd: () => {
          if (states.currentTabId && states.tabStates[states.currentTabId]) {
            states.tabStates[states.currentTabId].needsRender = true;
            states.tabStates[states.currentTabId].lastRenderedScrollTop = -1;
          }
          scheduleTick();
        },
      }),
    );
    cW.append(states.taskListContainer, states.tabsContainer);
    states.body.append(states.buttonsContainer, cW);
    states.container.append(states.header, states.body, rsz);
    document.body.appendChild(states.container);
    if (states.windowState.collapsed) {
      states.container.classList.add("collapsed");
      states.collapseIndicator.textContent = "+";
      states.container.style.width = "50px";
      states.container.style.height = "50px";
    } else {
      states.collapseIndicator.textContent = "−";
      states.container.style.width = states.windowState.width;
      states.container.style.height = states.windowState.height;
    }
    renderTabs();
    if (!states.windowState.collapsed && states.currentTabId)
      renderTasksForCurrentTab(true);
    const onlineHandler = handleConnectionRestored as EventListener,
      offlineHandler = handleConnectionLost as EventListener;
    unsafeWindow.addEventListener("online", onlineHandler);
    unsafeWindow.addEventListener("offline", offlineHandler);
    states.globalCleanupFunctions.push(() =>
      unsafeWindow.removeEventListener("online", onlineHandler),
    );
    states.globalCleanupFunctions.push(() =>
      unsafeWindow.removeEventListener("offline", offlineHandler),
    );
  }

  const TaskSelectorManager: TaskSelectorManagerAPI = {
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
          if (changed && tabId === states.currentTabId)
            affectsCurrentTab = true;
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

  unsafeWindow.TaskSelectorManager = TaskSelectorManager;

  function attemptInit() {
    if (document.body) {
      init();
    } else {
      document.addEventListener("DOMContentLoaded", init, { once: true });
    }
  }
  attemptInit();
}
