import { CustomWindow, BiliSelectScriptAPI_Interface } from "./types";
import { addSingleVideo } from "./utils";

export function BiliSelectScript(
  initialMediaId: string,
  window: CustomWindow,
): void {
  "use strict";

  const LOG_PREFIX = "[BiliSelectScript V3]";
  const VIDEO_CARD_SELECTOR = ".bili-video-card__wrap";
  const LINK_SELECTOR = "a.bili-cover-card, .bili-video-card__title a";
  const SELECTED_CLASS = "custom-card-selected-highlight-v3";
  const SELECTION_RECT_ID = "custom-selection-rectangle-v3";
  const DRAG_THRESHOLD = 5;
  const API_URL_PATTERN = /api\.bilibili\.com\/x\/v3\/fav\/resource\/list/;
  const EVENT_SCOPE_SELECTOR = ".fav-list-main";
  const VIDEO_LIST_CONTAINER_SELECTOR = ".fav-list-main";

  console.log(
    `${LOG_PREFIX} Detected favlist page. Initial media_id (fid): ${initialMediaId}. Initializing script.`,
  );

  // 在 BiliSelectScript 函数作用域内
  const BiliSelectScriptAPI: BiliSelectScriptAPI_Interface = {
    selectVideoCardByBv: (
      bvId: string,
      shouldSelect: boolean,
      originatingFromTaskManager: boolean = false,
      originMediaId: string | null = null,
    ): void => {
      log(
        `BiliSelectScriptAPI.selectVideoCardByBv called for BV: ${bvId}, select: ${shouldSelect}, fromTaskMgr: ${originatingFromTaskManager}`,
      );
      // 确保操作的是当前 media_id 的 selection 数组
      if (!selectionStorage[currentMediaId]) {
        selectionStorage[currentMediaId] = [];
      }
      currentSelection = selectionStorage[currentMediaId]; // 重新确认

      const container = findVideoListContainer(); // 确保获取到正确的容器
      if (!container) {
        log(
          "BiliSelectScriptAPI: Video list container not found for style update.",
        );
        // 即使容器找不到，我们仍然需要更新 currentSelection 存储
        const indexInCurrent = currentSelection.indexOf(bvId);
        if (shouldSelect && indexInCurrent === -1) {
          currentSelection.push(bvId);
        } else if (!shouldSelect && indexInCurrent > -1) {
          currentSelection.splice(indexInCurrent, 1);
        }
        logState(
          `BiliSelectScriptAPI: BV ${bvId} selection state updated in storage (no DOM container).`,
        );
        return;
      }

      let cardStateChangedInStorage = false;
      const index = currentSelection.indexOf(bvId);

      if (shouldSelect) {
        if (index === -1) {
          currentSelection.push(bvId);
          cardStateChangedInStorage = true;
        }
      } else {
        // shouldSelect is false
        if (index > -1) {
          currentSelection.splice(index, 1);
          // cardStateChangedInStorage = true;
        } else {
          const originSelection = selectionStorage[originMediaId!];
          originSelection.splice(originSelection.indexOf(bvId), 1);
        }
        cardStateChangedInStorage = true;
      }

      if (cardStateChangedInStorage) {
        logState(
          `BiliSelectScriptAPI: BV ${bvId} selection updated in storage to ${shouldSelect}.`,
        );
      }

      // 现在更新 DOM 中所有匹配的卡片
      const cards =
        container.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR);
      let visualChangeMade = false;
      cards.forEach((card) => {
        const cardBvId = getBvId(card);
        if (cardBvId === bvId) {
          if (shouldSelect) {
            if (!card.classList.contains(SELECTED_CLASS)) {
              addSelectedStyle(card);
              visualChangeMade = true;
            }
          } else {
            // shouldSelect is false
            if (card.classList.contains(SELECTED_CLASS)) {
              removeSelectedStyle(card);
              visualChangeMade = true;
            }
          }
        }
      });
      if (visualChangeMade) {
        log(
          `BiliSelectScriptAPI: Visual style for BV ${bvId} updated on page.`,
        );
      }
      // 如果存储状态改变了但视觉上没有改变（例如卡片还未加载），applySelectionStylesToPage 之后会处理
      if (cardStateChangedInStorage && !visualChangeMade && !shouldSelect) {
        log(
          `BiliSelectScriptAPI: BV ${bvId} was deselected in storage, but no matching card found in current DOM to remove style. Style will be handled by observer/applySelectionStylesToPage if card loads later.`,
        );
      }
    },
    isBvSelected: (bvId: string): boolean => {
      // 确保检查的是当前 media_id 的 selection
      return selectionStorage[currentMediaId]
        ? selectionStorage[currentMediaId].includes(bvId)
        : false;
    },
  };
  window.BiliSelectScriptAPI = BiliSelectScriptAPI;

  let selectionStorage: Record<string, string[]> = {};
  let currentMediaId: string = initialMediaId;
  let currentSelection: string[]; // Will point to selectionStorage[currentMediaId]

  if (!selectionStorage[currentMediaId]) {
    selectionStorage[currentMediaId] = [];
  }
  currentSelection = selectionStorage[currentMediaId];

  let isDragging = false;
  let startX = 0,
    startY = 0;
  let endX = 0,
    endY = 0;
  let didDrag = false;
  let selectionRectElement: HTMLDivElement | null = null;
  let videoListContainer: HTMLElement | null = null;

  function log(...args: any[]): void {
    console.log(LOG_PREFIX, ...args);
  }

  function logState(message: string = ""): void {
    if (message) log(message);
    log(`Current Media ID: ${currentMediaId}`);
    const selectionPreview =
      currentSelection.length > 10
        ? [
            ...currentSelection.slice(0, 10),
            `... (${currentSelection.length - 10} more)`,
          ]
        : [...currentSelection];
    log(
      `Current Selection (${currentSelection.length} items):`,
      selectionPreview,
    );
  }

  function getBvId(element: HTMLElement | null): string | null {
    if (!element) return null;
    const cardRoot = element.closest<HTMLElement>(VIDEO_CARD_SELECTOR);
    if (!cardRoot) return null;
    const linkElement =
      cardRoot.querySelector<HTMLAnchorElement>(LINK_SELECTOR);
    if (linkElement && linkElement.href) {
      const match = linkElement.href.match(/BV([a-zA-Z0-9]+)/);
      return match ? match[0] : null;
    }
    return null;
  }

  function addSelectedStyle(element: HTMLElement | null): void {
    if (element) element.classList.add(SELECTED_CLASS);
  }
  function removeSelectedStyle(element: HTMLElement | null): void {
    if (element) element.classList.remove(SELECTED_CLASS);
  }

  function toggleSelection(element: HTMLElement): void {
    const bvId = getBvId(element);
    if (!bvId || !currentMediaId) return;

    if (!selectionStorage[currentMediaId]) {
      log(`Error: Selection array for ${currentMediaId} missing. Recreating.`);
      selectionStorage[currentMediaId] = [];
    }
    currentSelection = selectionStorage[currentMediaId]; // Ensure pointer is correct

    const index = currentSelection.indexOf(bvId);
    let isNowSelected: boolean;

    if (index > -1) {
      // Deselecting in BiliSelectScript
      currentSelection.splice(index, 1);
      removeSelectedStyle(element);
      isNowSelected = false;
      logState(`Deselected: ${bvId} (user action)`);
    } else {
      // Selecting in BiliSelectScript
      currentSelection.push(bvId);
      addSelectedStyle(element);
      isNowSelected = true;
      logState(`Selected: ${bvId} (user action)`);
      // 确保任务已添加到 TaskManager
      // addSingleVideo 应该能处理重复添加（不重复添加任务，但可能重复获取分页）
      // 或者 TaskManager.addTaskData 本身就是幂等的
      if (window.TaskSelectorManager) {
        const folderName =
          window.folders?.get(currentMediaId) || "Unknown Folder";
        // Pass true for the new parameter
        addSingleVideo(String(currentMediaId), folderName, bvId!, window, true);
      }
    }

    // Sync selection state with TaskManager
    if (window.TaskSelectorManager) {
      console.log(
        `BiliSelect.toggleSelection: Calling TaskManager.selectTasksByBv for ${bvId}, select: ${isNowSelected}`,
      );
      window.TaskSelectorManager.selectTasksByBv(bvId, isNowSelected, true);
    }
  }

  function updateSelectionRect(): void {
    if (!selectionRectElement) {
      selectionRectElement = document.createElement("div");
      selectionRectElement.id = SELECTION_RECT_ID;
      document.body.appendChild(selectionRectElement);
    }
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);
    selectionRectElement.style.left = `${x}px`;
    selectionRectElement.style.top = `${y}px`;
    selectionRectElement.style.width = `${width}px`;
    selectionRectElement.style.height = `${height}px`;
  }

  function removeSelectionRect(): void {
    if (selectionRectElement) {
      selectionRectElement.remove();
      selectionRectElement = null;
    }
  }

  function isIntersecting(
    element: HTMLElement,
    rectBounds: { left: number; top: number; right: number; bottom: number },
  ): boolean {
    const elemRect = element.getBoundingClientRect();
    return !(
      elemRect.right < rectBounds.left ||
      elemRect.left > rectBounds.right ||
      elemRect.bottom < rectBounds.top ||
      elemRect.top > rectBounds.bottom
    );
  }

  // In BiliSelectScript
  function applySelectionStylesToPage(): void {
    if (!currentMediaId) {
      log("ApplyStyles: No currentMediaId set, skipping.");
      return;
    }
    if (!selectionStorage.hasOwnProperty(currentMediaId)) {
      log(
        `ApplyStyles: No selection array for ${currentMediaId} yet. Creating empty.`,
      );
      selectionStorage[currentMediaId] = [];
    }
    currentSelection = selectionStorage[currentMediaId]; // 关键：始终使用当前 media_id 的选择

    log(
      `ApplyStyles: Applying styles for media_id: ${currentMediaId} (Items stored: ${currentSelection.length})`,
    );
    const container = findVideoListContainer();
    if (!container) {
      log("ApplyStyles: Container not found, cannot apply styles.");
      return;
    }

    const cards = container.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR);
    log(
      `ApplyStyles: Found ${cards.length} cards in container to check for media_id ${currentMediaId}.`,
    );
    let styledCount = 0;
    cards.forEach((card) => {
      const bvId = getBvId(card);
      if (bvId) {
        if (currentSelection.includes(bvId)) {
          addSelectedStyle(card);
          styledCount++;
        } else {
          removeSelectedStyle(card); // 确保未选中的没有样式
        }
      } else {
        removeSelectedStyle(card); // 如果找不到 BV ID，也移除样式
      }
    });
    log(
      `ApplyStyles: Style application complete for ${currentMediaId}. ${styledCount} items styled as selected.`,
    );
  }

  function findVideoListContainer(): HTMLElement | null {
    if (!videoListContainer || !document.body.contains(videoListContainer)) {
      videoListContainer = document.querySelector<HTMLElement>(
        VIDEO_LIST_CONTAINER_SELECTOR,
      );
    }
    return videoListContainer;
  }

  function handleMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest(EVENT_SCOPE_SELECTOR)) return;

    if (
      event.button !== 0 ||
      target.closest(
        "a, button, input, .bili-card-dropdown, .bili-card-checkbox, .bili-card-watch-later",
      )
    )
      return;

    isDragging = true;
    didDrag = false;
    startX = event.clientX;
    startY = event.clientY;
    endX = event.clientX;
    endY = event.clientY;

    document.body.style.userSelect = "none";
    document.body.classList.add("custom-dragging-v3");
  }

  function handleMouseMove(event: MouseEvent): void {
    if (!isDragging) return;

    endX = event.clientX;
    endY = event.clientY;

    if (
      !didDrag &&
      (Math.abs(endX - startX) > DRAG_THRESHOLD ||
        Math.abs(endY - startY) > DRAG_THRESHOLD)
    ) {
      didDrag = true;
      log("Drag started (threshold crossed)");
    }

    if (didDrag) {
      event.preventDefault();
      updateSelectionRect();
    }
  }

  function handleMouseUp(event: MouseEvent): void {
    void event;
    if (!isDragging) return;
    isDragging = false;

    document.body.style.userSelect = "";
    document.body.classList.remove("custom-dragging-v3");

    if (didDrag) {
      log("Drag ended");
      removeSelectionRect();
      const rectBounds = {
        left: Math.min(startX, endX),
        top: Math.min(startY, endY),
        right: Math.max(startX, endX),
        bottom: Math.max(startY, endY),
      };

      const container = findVideoListContainer();
      if (!container) {
        log("Error: Cannot find container for drag selection.");
        didDrag = false;
        return;
      }
      const cards =
        container.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR);
      log(`DragSelect: Checking ${cards.length} cards...`);
      let changedCount = 0;
      cards.forEach((card) => {
        if (isIntersecting(card, rectBounds)) {
          toggleSelection(card);
          changedCount++;
        }
      });
      if (changedCount > 0)
        logState(`Selection updated via drag (${changedCount} toggled)`);
      else log("DragSelect: No items intersected.");
    }
    didDrag = false;
  }

  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest(EVENT_SCOPE_SELECTOR)) return;
    if (didDrag) return; // Was a drag, not a click

    const targetCard = target.closest<HTMLElement>(VIDEO_CARD_SELECTOR);
    if (!targetCard) return;

    if (
      target.closest(
        "a, button, input, .bili-card-dropdown, .bili-card-checkbox, .bili-card-watch-later",
      )
    )
      return;

    toggleSelection(targetCard);
  }

  const originalFetch = window.fetch;
  window.fetch = async (
    ...args: [RequestInfo | URL, RequestInit?]
  ): Promise<Response> => {
    const url = args[0] instanceof Request ? args[0].url : String(args[0]);
    const method =
      args[0] instanceof Request ? args[0].method : args[1]?.method || "GET";

    log(`Fetch detected: ${method} ${url}`);

    if (url && API_URL_PATTERN.test(url)) {
      log(`FETCH: Detected target API call: ${url}`);
      try {
        const urlParams = new URLSearchParams(url.split("?")[1]);
        const fetchMediaId = urlParams.get("media_id");
        const fetchPn = urlParams.get("pn");

        if (fetchMediaId && fetchMediaId !== currentMediaId) {
          log(
            `FETCH: Media ID changing from ${currentMediaId} to ${fetchMediaId}. Updating state...`,
          );
          currentMediaId = fetchMediaId;
          if (!selectionStorage.hasOwnProperty(currentMediaId)) {
            log(
              `FETCH: Creating new empty selection array for new media_id: ${currentMediaId}`,
            );
            selectionStorage[currentMediaId] = [];
          } else {
            log(
              `FETCH: Switching to existing selection array for media_id: ${currentMediaId}`,
            );
          }
          currentSelection = selectionStorage[currentMediaId];
          logState(
            `FETCH: Switched active context to media_id ${currentMediaId}`,
          );
          requestAnimationFrame(applySelectionStylesToPage);
        } else if (fetchMediaId && fetchMediaId === currentMediaId) {
          log(
            `FETCH: Media ID ${currentMediaId} same (pn=${fetchPn}). State persists.`,
          );
        } else {
          log("FETCH: Target API call, but media_id missing or unexpected.");
        }
      } catch (error: any) {
        log("FETCH: Error parsing fetch URL parameters:", error.message);
      }
    }

    // responsePromise is the Promise returned by the fetch call. It will eventually
    // resolve with a Response object or reject with an error.
    const responsePromise: Promise<Response> = originalFetch.apply(
      window,
      args as any,
    );

    responsePromise
      .then((response: Response) => {
        // 'response' is the object that the Promise successfully resolves with.
        // It is of the built-in 'Response' type, which contains information like
        // status codes, headers, and the response body.
        return response;
      })
      .catch((error: any) => {
        // 'error' is the value passed to the rejection handler if the Promise fails.
        // Its type is typically 'any' or 'unknown' because any kind of value can be
        // thrown as an error (event.g., an Error object, a string, etc.).
        // A network failure during a fetch call often results in a TypeError.
        log(
          `FETCH: Error during fetch for ${url.substring(0, 100)}... :`,
          error,
        );
        throw error; // Re-throwing the error is important to propagate the failure.
      });

    return responsePromise;
  };

  const observerCallback: MutationCallback = (mutationsList, observer) => {
    void observer;
    let relevantChangeDetected = false;
    for (const mutation of mutationsList) {
      if (mutation.type === "childList") {
        const checkNodes = (nodes: NodeList): boolean => {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              ((node as HTMLElement).matches(VIDEO_CARD_SELECTOR) ||
                (node as HTMLElement).querySelector(VIDEO_CARD_SELECTOR))
            ) {
              return true;
            }
          }
          return false;
        };
        if (
          checkNodes(mutation.addedNodes) ||
          checkNodes(mutation.removedNodes)
        ) {
          relevantChangeDetected = true;
          break;
        }
      }
    }

    if (relevantChangeDetected) {
      log("Observer: Relevant DOM change detected. Re-applying styles...");
      requestAnimationFrame(applySelectionStylesToPage);
    }
  };

  const observer = new MutationObserver(observerCallback);
  const observerConfig: MutationObserverInit = {
    childList: true,
    subtree: true,
  };

  function startObserver(): void {
    const targetNode = findVideoListContainer();
    if (targetNode) {
      log(`Observer: Starting observer on:`, targetNode);
      try {
        observer.disconnect();
        observer.observe(targetNode, observerConfig);
      } catch (error: any) {
        log("Observer: Error starting:", error.message);
      }
    } else {
      log("Observer: Container not found. Retrying observer setup in 1s...");
      setTimeout(startObserver, 1000);
    }
  }

  function injectStylesBiliSelect(): void {
    const css = `
            .${SELECTED_CLASS} {
                outline: 3px solid #00a1d6 !important;
                box-shadow: 0 0 10px rgba(0, 161, 214, 0.8) !important;
                border-radius: 6px;
                transform: translateZ(0);
                background-color: rgba(0, 161, 214, 0.03);
            }
            #${SELECTION_RECT_ID} {
                position: fixed;
                border: 1px dashed #00a1d6;
                background-color: rgba(0, 161, 214, 0.15);
                z-index: 9999;
                pointer-events: none;
            }
            body.custom-dragging-v3 {
                user-select: none !important;
                -webkit-user-select: none !important;
                -moz-user-select: none !important;
                -ms-user-select: none !important;
            }
        `;
    const styleId = "bili-select-script-styles-v3";
    let existingStyle = document.getElementById(styleId);
    if (existingStyle) existingStyle.remove();

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
    log("Injected custom styles for BiliSelectScript.");
  }

  window.showBiliSelections = (mediaId: string | null = null): void => {
    console.log(`${LOG_PREFIX} --- Inspecting Selection Storage ---`);
    if (mediaId) {
      if (selectionStorage.hasOwnProperty(mediaId)) {
        console.log(
          `Selections for media_id "${mediaId}" (${selectionStorage[mediaId].length} items):`,
        );
        if (selectionStorage[mediaId].length > 0) {
          console.table(selectionStorage[mediaId].map((bv) => ({ BV_ID: bv })));
        } else {
          console.log("(This list is currently empty)");
        }
      } else {
        console.log(`No selection data found for media_id: ${mediaId}`);
        console.log(
          `Currently tracked media_ids:`,
          Object.keys(selectionStorage),
        );
      }
    } else {
      const trackedIds = Object.keys(selectionStorage);
      if (trackedIds.length === 0) {
        console.log("No selections have been tracked yet.");
      } else {
        console.log("All tracked selections by media_id:");
        console.log(JSON.parse(JSON.stringify(selectionStorage)));
        const tableData: Record<string, { Count: number; Preview: string }> =
          {};
        for (const id in selectionStorage) {
          if (selectionStorage.hasOwnProperty(id)) {
            const selectionArray = selectionStorage[id];
            const count = selectionArray.length;
            const preview = selectionArray.slice(0, 5).join(", ");
            tableData[id] = {
              Count: count,
              Preview: count > 5 ? `${preview}...` : preview || "(empty)",
            };
          }
        }
        console.log("Summary view:");
        console.table(tableData);
      }
    }
    console.log(`${LOG_PREFIX} --- End Inspection ---`);
  };

  window.removeBiliSelections = (
    mediaId: string,
    bvIdsToRemove: string[],
  ): void => {
    console.log(`${LOG_PREFIX} --- Attempting Batch Removal ---`);
    if (typeof mediaId !== "string" || !mediaId) {
      console.error(`${LOG_PREFIX} Invalid media_id provided.`);
      console.log(`${LOG_PREFIX} --- Removal Failed ---`);
      return;
    }
    if (!Array.isArray(bvIdsToRemove)) {
      console.error(
        `${LOG_PREFIX} Invalid bvIdsToRemove provided (must be an array).`,
      );
      console.log(`${LOG_PREFIX} --- Removal Failed ---`);
      return;
    }
    if (bvIdsToRemove.length === 0) {
      log(`No BV IDs provided for removal from media_id ${mediaId}.`);
      console.log(`${LOG_PREFIX} --- Removal Complete (No Action) ---`);
      return;
    }
    if (!selectionStorage.hasOwnProperty(mediaId)) {
      log(`Media ID "${mediaId}" not found in storage.`);
      console.log(`${LOG_PREFIX} --- Removal Failed ---`);
      return;
    }

    const initialCount = selectionStorage[mediaId].length;
    log(
      `Removing items from media_id "${mediaId}". Initial: ${initialCount}. Removing:`,
      bvIdsToRemove,
    );
    selectionStorage[mediaId] = selectionStorage[mediaId].filter(
      (bv) => !bvIdsToRemove.includes(bv),
    );
    const finalCount = selectionStorage[mediaId].length;
    const removedCount = initialCount - finalCount;
    log(
      `Removal complete. ${removedCount} item(s) removed. Final count: ${finalCount}.`,
    );

    if (mediaId === currentMediaId) {
      log("Updating page visuals as the current list was modified.");
      requestAnimationFrame(applySelectionStylesToPage);
      logState("State updated after batch removal");
    } else {
      log(
        `(Visuals not updated as media_id "${mediaId}" is not current: "${currentMediaId}")`,
      );
    }
    console.log(`${LOG_PREFIX} --- Removal Complete ---`);
  };

  function runInitialization(): void {
    injectStylesBiliSelect();
    document.addEventListener("mousedown", handleMouseDown, false);
    document.addEventListener("mousemove", handleMouseMove, false);
    document.addEventListener("mouseup", handleMouseUp, false);
    document.addEventListener("click", handleClick, true); // Use capture for click to potentially override other listeners

    startObserver();
    requestAnimationFrame(applySelectionStylesToPage);

    logState("Initial state after page load for BiliSelectScript");
    log(
      'API functions "showBiliSelections(mediaId?)" and "removeBiliSelections(mediaId, bvIdArray)" are available.',
    );
    log("BiliSelectScript initialization complete.");

    // Initial sync: After BiliSelectScript has established its selections (event.g. from cache or default)
    // Tell TaskManager about BiliSelect's current selections for the active media_id
    if (
      window.TaskSelectorManager &&
      currentSelection &&
      currentSelection.length > 0
    ) {
      log(
        `BiliSelect init: Performing initial sync with TaskManager for ${currentSelection.length} selected BVs.`,
      );
      currentSelection.forEach((selectedBvId) => {
        // Ensure tasks for this BV are loaded in TaskManager first
        const folderName =
          window.folders?.get(currentMediaId) || "Unknown Folder";
        // Pass true here as well, these are selected in BiliSelect
        addSingleVideo(
          String(currentMediaId),
          folderName,
          selectedBvId,
          window,
          true,
        );
        window.TaskSelectorManager!.selectTasksByBv(selectedBvId, true, true);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runInitialization);
  } else {
    runInitialization();
  }
}
