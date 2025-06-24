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

export function findChildTaskByIdGlobal(childId: string): Task | null {
  return states.taskMap.get(childId) || null;
}
