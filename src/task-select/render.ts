import { states } from "./states";
import { FlatTaskItem, ParentTask, Task, TabData } from "./types";
import { TaskSelectorManager } from "./utils";

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

export function renderTabs(): void {
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

export function renderProgressItems(
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

export function scheduleTick(): void {
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

function toggleParentTaskExpansion(parentTask: ParentTask): void {
  parentTask.isExpanded = !parentTask.isExpanded;
  if (states.currentTabId && states.tabStates[states.currentTabId]) {
    states.tabStates[states.currentTabId].needsCacheUpdate = true;
    states.tabStates[states.currentTabId].needsRender = true;
    states.tabStates[states.currentTabId].lastRenderedScrollTop = -1;
    scheduleTick();
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

export function renderTasksForCurrentTab(forceUpdate: boolean = false): void {
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
      node = createChildTaskNode(childData, parentData.bv, parentData.MediaId);
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
