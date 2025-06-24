import { TaskSelectorManager } from "./utils";
import { states } from "./states";
import { renderTasksForCurrentTab, scheduleTick, renderTabs } from "./render";
import { toggleCollapse, handleMouseDownTaskList, handleTabsScroll, handleTaskListScroll, handleConnectionLost, handleConnectionRestored } from "./events";
import { injectStyles } from "./ui";
import { createDragHandler, createResizeHandler } from "./interations";
import { confirmSelection, deselectAllTasks, selectVisibleTasks, deselectVisibleTasks, selectAllTasksInTab } from "./actions";

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


  const debouncedTabsScrollSave = debounce(handleTabsScroll, 150);

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
