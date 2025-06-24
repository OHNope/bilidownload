import { states } from "./states";
import { SelectedTask, ProgressTaskItem, ProgressWindowState } from "./types";
import { scheduleTick } from "./render";
import { updateTaskStateById } from "./utils";
import { renderProgressItems } from "./render";
import { createDragHandler, createResizeHandler } from "./interations";

export const styles: string = `
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

function handleProgressScroll(windowId: string): void {
  const pwData = states.progressWindows[windowId];
  const pwState = pwData?.state;
  if (!pwData?.listElement || !pwState) return;
  pwState.scrollTop = pwData.listElement.scrollTop;
  pwState.needsRender = true;
  scheduleTick();
}

export function createProgressWindow(tasksForWindow: SelectedTask[]): string {
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

export function closeProgressWindow(windowId: string): void {
  const pw = states.progressWindows[windowId];
  if (!pw?.element) return;
  pw.cleanupFunctions.forEach((cleanup) => cleanup());
  pw.listElement?.removeEventListener("scroll", pw.handleScroll);
  pw.element.remove();
  delete states.progressWindows[windowId];
}
