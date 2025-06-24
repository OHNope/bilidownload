import { states } from "./states";
import { renderTasksForCurrentTab, scheduleTick, renderTabs } from "./render";
import { toggleCollapse, handleMouseDownTaskList, handleTabsScroll, handleTaskListScroll, handleConnectionLost, handleConnectionRestored } from "./events";
import { injectStyles } from "./ui";
import { createDragHandler, createResizeHandler } from "./interations";
import { confirmSelection, deselectAllTasks, selectVisibleTasks, deselectVisibleTasks, selectAllTasksInTab } from "./actions";
import { TaskSelectorManagerAPI } from "../core/types"; // 导入接口
import { ParentTask, Task } from "./types"; // 导入类型
import { findChildTaskByIdGlobal } from "./utils"; // 导入需要的工具函数
import { closeProgressWindow } from "./ui"; // 导入需要的UI函数

// --- 新的 TaskSelectorManager 类定义 ---
export class TaskSelectorManager implements TaskSelectorManagerAPI {
  constructor() {
    // --- 防止重复注入 ---
    if (unsafeWindow.TaskSelectorManager) {
      console.log(
        "Task Selector Manager already injected. Destroying previous instance.",
      );
      unsafeWindow.TaskSelectorManager.destroy?.();
    }

    // 立即开始初始化
    this.#init();
  }

  // --- 初始化逻辑 (从原 init 函数移入) ---
  #init(): void {
    if (states.container) return;

    const debouncedTabsScrollSave = (<T extends (...args: any[]) => void>(
      func: T,
      wait: number,
    ): (...args: Parameters<T>) => void => {
      let timeout: number | undefined;
      return (...args: Parameters<T>) => {
        const later = () => {
          clearTimeout(timeout);
          func(...args);
        };
        clearTimeout(timeout);
        timeout = unsafeWindow.setTimeout(later, wait);
      };
    })(handleTabsScroll, 150);
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
      { text: "确认选中", action: confirmSelection, title: "处理选中的任务并创建进度窗口" },
      { text: "选可见", action: selectVisibleTasks, title: "选择当前列表视区内所有任务" },
      { text: "全不选", action: deselectAllTasks, title: "取消选择所有分页中的全部任务" },
      { text: "去可见", action: deselectVisibleTasks, title: "取消选择当前列表视区内的任务" },
      { text: "选分页", action: selectAllTasksInTab, title: "选择当前分页下的所有任务" },
    ].forEach((bi) => {
      const b = document.createElement("button");
      b.textContent = bi.text;
      b.title = bi.title;
      b.addEventListener("click", (e) => { e.stopPropagation(); bi.action(); });
      states.buttonsContainer!.appendChild(b);
    });
    const cW = document.createElement("div");
    cW.className = "task-selector-content-wrapper";
    states.taskListContainer = document.createElement("div");
    states.taskListContainer.className = "task-selector-task-list-container";
    states.taskListContainer.addEventListener("scroll", handleTaskListScroll, { passive: true });
    states.taskListContainer.addEventListener("pointerdown", handleMouseDownTaskList as EventListener);
    const spacer = document.createElement("div");
    spacer.className = "virtual-scroll-spacer";
    states.taskListContainer.appendChild(spacer);
    states.tabsContainer = document.createElement("div");
    states.tabsContainer.className = "task-selector-tabs-container";
    states.tabsContainer.addEventListener("scroll", debouncedTabsScrollSave, { passive: true });
    const rsz = document.createElement("div");
    rsz.className = "task-selector-resizer";
    states.globalCleanupFunctions.push(
      createResizeHandler({
        resizeHandleElement: rsz, resizableElement: states.container, state: states.windowState,
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
    if (!states.windowState.collapsed && states.currentTabId) renderTasksForCurrentTab(true);
    const onlineHandler = handleConnectionRestored as EventListener,
      offlineHandler = handleConnectionLost as EventListener;
    unsafeWindow.addEventListener("online", onlineHandler);
    unsafeWindow.addEventListener("offline", offlineHandler);
    states.globalCleanupFunctions.push(() => unsafeWindow.removeEventListener("online", onlineHandler));
    states.globalCleanupFunctions.push(() => unsafeWindow.removeEventListener("offline", offlineHandler));

    // 将自身实例暴露给 window
    unsafeWindow.TaskSelectorManager = this;
  }

  // --- 公共 API 方法 (从 utils.ts 移入) ---
  public addTaskData(tabId: string, tabName: string, parentTaskInputs: any[], autoSelectNewChildren = false): void {
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
      const children: Task[] = videoInput.pages.map((page: any) => ({
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
  }

  public updateTaskProgress(wId: string, tId: string, p: number): void {
    states.progressWindows[String(wId)]?.updateProgress(String(tId), p)
  }

  public getSelectedTaskIds(): string[] {
    return Array.from(states.selectedTaskIds);
  }

  public isTaskSelected(taskId: string): boolean {
    return states.selectedTaskIds.has(taskId);
  }

  public isAnyTaskSelectedForBv(bvId: string): boolean {
    if (!bvId) return false;
    for (const taskId of states.selectedTaskIds) {
      const taskData = findChildTaskByIdGlobal(taskId);
      if (taskData && taskData.bv === bvId) return true;
    }
    return false;
  }

  public selectTasksByBv(bvId: string, shouldSelect: boolean): void {
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
  }

  public destroy(): void {
    if (!states.container) return;
    states.globalCleanupFunctions.forEach((cleanup) => cleanup());
    states.globalCleanupFunctions.length = 0;
    Object.keys(states.progressWindows).forEach(closeProgressWindow);
    states.container.remove();
    document.getElementById("task-selector-styles")?.remove();
    // Reset all states
    Object.assign(states, {
      allTasksData: {},
      selectedTaskIds: new Set<string>(),
      markedTaskIds: new Set<string>(),
      taskMap: new Map<string, Task>(),
      activeDownloads: new Map(),
      currentTabId: null,
      tabStates: {},
      windowState: { collapsed: true, top: "20px", left: "20px", width: "350px", height: "450px" },
      progressWindows: {},
      progressWindowCounter: 0,
      isSelectingBox: false,
      selectionBoxStart: { x: 0, y: 0 },
      tickScheduled: false,
      container: null,
      header: null,
      body: null,
      taskListContainer: null,
      tabsContainer: null,
      buttonsContainer: null,
      collapseIndicator: null,
      selectionBoxElement: null,
    });
    // Crucially, remove the global reference to allow for garbage collection and re-initialization
    delete unsafeWindow.TaskSelectorManager;
  }
}