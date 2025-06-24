import { TaskSelectorManager } from "./utils";
import { download } from "./download";
import { updateTaskStateById } from "./utils";
import { states } from "./states";
import { closeProgressWindow } from "./ui";
import { SelectedTask } from "./types";
import { renderTasksForCurrentTab, scheduleTick, renderTabs } from "./render";
import { findChildTaskByIdGlobal } from "./utils";
import { toggleCollapse, handleMouseDownTaskList } from "./events";
import { injectStyles, createProgressWindow } from "./ui";
import { createDragHandler, createResizeHandler } from "./interations";

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
