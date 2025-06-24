import { findChildTaskByIdGlobal } from "./utils";
import { states } from "./states";
import { createProgressWindow, closeProgressWindow } from "./ui";
import { download } from "./download";
import { renderTasksForCurrentTab } from "./render";
import { SelectedTask } from "./types";
import { TaskSelectorManager } from "./utils";

export function confirmSelection(): string | undefined {
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

export function selectVisibleTasks(): void {
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

export function deselectVisibleTasks(): void {
    processVisibleTasks((taskId) => {
        if (states.selectedTaskIds.has(taskId)) {
            states.selectedTaskIds.delete(taskId);
            return true;
        }
        return false;
    });
}

export function deselectAllTasks(): void {
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

export function selectAllTasksInTab(): void {
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