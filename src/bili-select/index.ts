import { BiliSelectScriptAPI_Interface } from "../core/types";
import { addSingleVideo } from "../core/utils";

export function BiliSelectScript(initialMediaId: string): void {
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
          originSelection?.splice(originSelection.indexOf(bvId), 1);
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
  unsafeWindow.BiliSelectScriptAPI = BiliSelectScriptAPI;

  let selectionStorage: Record<string, string[]> = {};
  let currentMediaId: string = initialMediaId;
  let currentSelection: string[]; // Will point to selectionStorage[currentMediaId]

  if (!selectionStorage[currentMediaId]) {
    selectionStorage[currentMediaId] = [];
  }
  currentSelection = selectionStorage[currentMediaId];
  // -- 拖拽与选择状态管理 --
  let isMouseDown = false; // 替代旧的 isDragging
  let didDrag = false; // 用于区分单击和拖拽
  let isDragSelecting = false; // 标记是否正在进行框选

  let selectionRectElement: HTMLDivElement | null = null;
  let videoListContainer: HTMLElement | null = null;

  // --- 新增：高级框选所需的状态变量 ---
  let lastClientX = 0;
  let lastClientY = 0;
  let autoScrollDirection = 0; // -1: up, 1: down, 0: none
  let startScrollTop = 0;
  let startContainerRect: DOMRect | null = null;
  let selectionBoxStart = { x: 0, y: 0 };
  let initialSelectedInDragOp = new Set<string>(); // 存储拖拽开始时的BV ID
  const AUTO_SCROLL_ZONE_SIZE = 60; // 页面边缘触发滚动的区域大小 (px)
  const AUTO_SCROLL_SPEED_MAX = 20; // 页面滚动的最大速度
  // --- 结束新增 ---

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
  /**
   * 主视觉循环，在鼠标按下和松开之间持续运行。
   * 负责处理自动滚动和选择框的重绘。
   */
  function tickDragSelectionLoop(): void {
    if (!isDragSelecting) return;

    // 1. 如果需要，执行页面自动滚动
    if (autoScrollDirection !== 0) {
      unsafeWindow.scrollBy(0, AUTO_SCROLL_SPEED_MAX * autoScrollDirection);
    }

    // 2. 更新选择框的视觉样式（处理坐标转换）
    updateSelectionRectangleVisuals();

    // 3. 根据选择框更新视频卡的“预览”选中状态
    updateSelectionFromRectangle(false);

    // 4. 请求下一帧，继续动画循环
    requestAnimationFrame(tickDragSelectionLoop);
  }

  /**
   * 根据已存储的起始点和最新的鼠标坐标，更新选择框的视觉位置和尺寸。
   * 这个函数是更新选择框样式的唯一来源，并正确处理页面滚动带来的坐标转换。
   */
  function updateSelectionRectangleVisuals(): void {
    if (!selectionRectElement) return;

    // 1. 获取当前页面的滚动偏移量
    const scrollX =
      unsafeWindow.pageXOffset || document.documentElement.scrollLeft;
    const scrollY =
      unsafeWindow.pageYOffset || document.documentElement.scrollTop;

    // 2. 计算“锚点”（鼠标按下的点）在整个文档中的绝对坐标。
    //    这个坐标在拖拽期间是固定不变的。
    //    鼠标在视口中的初始位置 + 页面在拖拽开始时的滚动距离
    const anchorX =
      selectionBoxStart.x +
      (startContainerRect?.left ?? 0) +
      scrollX -
      (document.documentElement.clientLeft || 0);
    const anchorY = selectionBoxStart.y + startScrollTop;

    // 3. 计算“活动点”（鼠标当前的位置）在整个文档中的绝对坐标。
    //    这个坐标会随着鼠标移动而实时变化。
    //    鼠标在视口中的当前位置 + 页面当前的滚动距离
    const activeX = lastClientX + scrollX;
    const activeY = lastClientY + scrollY;

    // 4. 根据“锚点”和“活动点”这两个在同一坐标系下的点，确定选择框的最终样式。
    const finalTop = Math.min(anchorY, activeY);
    const finalLeft = Math.min(anchorX, activeX);
    const finalHeight = Math.abs(anchorY - activeY);
    const finalWidth = Math.abs(anchorX - activeX);

    // 5. 应用样式
    Object.assign(selectionRectElement.style, {
      top: `${finalTop}px`,
      left: `${finalLeft}px`,
      height: `${finalHeight}px`,
      width: `${finalWidth}px`,
    });
  }

  /**
   * 根据选择框的位置，更新视频卡的选中状态。
   * @param {boolean} isFinal - 在mouseup时为true，用于将预览状态提交到数据层。
   */
  function updateSelectionFromRectangle(isFinal: boolean = false): void {
    if (!selectionRectElement) return;

    const rectBounds = selectionRectElement.getBoundingClientRect();
    const container = findVideoListContainer();
    if (!container) return;

    const cards = container.querySelectorAll<HTMLElement>(VIDEO_CARD_SELECTOR);
    if (cards.length === 0) return;

    if (isFinal) {
      // --- 提交模式 (isFinal = true) ---
      // 遍历所有卡片，根据它们最终的视觉状态来更新数据
      let changed = false;
      cards.forEach((card) => {
        const bvId = getBvId(card);
        if (!bvId) return;

        const isNowSelected = card.classList.contains(SELECTED_CLASS);
        const wasOriginallySelected = initialSelectedInDragOp.has(bvId);

        // 如果状态发生了变化，则调用 toggleSelection 来同步所有数据
        if (isNowSelected !== wasOriginallySelected) {
          changed = true;
          // 注意：toggleSelection会反转状态，所以我们要确保调用它时，
          // 卡片的当前状态是正确的。因为预览时已经设置了class，所以直接调用即可。
          // toggleSelection 会处理所有事情：更新数组, 更新class, 同步TaskMgr。
          // 但它会再次反转class，所以我们先反转一下
          card.classList.toggle(SELECTED_CLASS);
          toggleSelection(card);
        }
      });
      if (changed) logState("Selection updated via drag");
    } else {
      // --- 预览模式 (isFinal = false) ---
      // MODIFICATION START: Real-time sync with TaskSelectorManager
      cards.forEach((card) => {
        const bvId = getBvId(card);
        if (!bvId) return;

        // 1. 计算此卡片在本次拖拽操作中的“期望”选中状态
        let shouldBeSelectedNow: boolean;
        if (isIntersecting(card, rectBounds)) {
          // 在框选矩形内，状态与初始状态相反
          shouldBeSelectedNow = !initialSelectedInDragOp.has(bvId);
        } else {
          // 在框选矩形外，状态恢复为初始状态
          shouldBeSelectedNow = initialSelectedInDragOp.has(bvId);
        }

        // 2. 更新此卡片的视觉样式
        if (shouldBeSelectedNow) {
          addSelectedStyle(card);
        } else {
          removeSelectedStyle(card);
        }

        // 3. 【关键】将此“期望”状态实时同步到 TaskSelectorManager
        if (unsafeWindow.TaskSelectorManager) {
          // `true` 表示这个选择状态的改变源自 BiliSelectScript
          unsafeWindow.TaskSelectorManager.selectTasksByBv(
            bvId,
            shouldBeSelectedNow,
            true,
          );
        }
      });
      // MODIFICATION END
    }
  }

  function removeSelectionRect(): void {
    if (selectionRectElement) {
      selectionRectElement.remove();
      selectionRectElement = null;
    }
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
      if (unsafeWindow.TaskSelectorManager) {
        const folderName =
          unsafeWindow.folders?.get(currentMediaId) || "Unknown Folder";
        // Pass true for the new parameter
        addSingleVideo(String(currentMediaId), folderName, bvId!, true);
      }
    }

    // Sync selection state with TaskManager
    if (unsafeWindow.TaskSelectorManager) {
      console.log(
        `BiliSelect.toggleSelection: Calling TaskManager.selectTasksByBv for ${bvId}, select: ${isNowSelected}`,
      );
      unsafeWindow.TaskSelectorManager.selectTasksByBv(
        bvId,
        isNowSelected,
        true,
      );
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
    if (
      !target.closest(EVENT_SCOPE_SELECTOR) ||
      event.button !== 0 ||
      target.closest(
        "a, button, input, .bili-card-dropdown, .bili-card-checkbox, .bili-card-watch-later",
      )
    ) {
      return;
    }

    isMouseDown = true;
    didDrag = false;
    isDragSelecting = true;

    // 1. 捕获初始状态
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    selectionBoxStart = { x: event.clientX, y: event.clientY };
    // 【关键】直接使用 unsafeWindow.pageYOffset 获取最准确的页面滚动值
    startScrollTop =
      unsafeWindow.pageYOffset || document.documentElement.scrollTop;

    // 2. 记录当前所有已选中项的 BV ID
    initialSelectedInDragOp.clear();
    currentSelection.forEach((bvId) => initialSelectedInDragOp.add(bvId));

    // 3. 创建选择框
    removeSelectionRect(); // 确保清理旧的
    selectionRectElement = document.createElement("div");
    selectionRectElement.id = SELECTION_RECT_ID;
    document.body.appendChild(selectionRectElement);
    selectionRectElement.style.display = "block";

    // 4. 添加监听器并启动主循环
    document.addEventListener("mousemove", handleMouseMove, { passive: false });
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "none";
    requestAnimationFrame(tickDragSelectionLoop);
  }

  function handleMouseMove(event: MouseEvent): void {
    if (!isMouseDown) return;
    event.preventDefault();

    // 标记发生了拖拽
    if (!didDrag) {
      const dx = Math.abs(event.clientX - selectionBoxStart.x);
      const dy = Math.abs(event.clientY - selectionBoxStart.y);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        didDrag = true;
      }
    }

    // 轻量级更新：只更新坐标和滚动信号
    lastClientX = event.clientX;
    lastClientY = event.clientY;

    let scrollDirection = 0;
    if (lastClientY < AUTO_SCROLL_ZONE_SIZE) {
      scrollDirection = -1; // 向上
    } else if (lastClientY > unsafeWindow.innerHeight - AUTO_SCROLL_ZONE_SIZE) {
      scrollDirection = 1; // 向下
    }
    autoScrollDirection = scrollDirection;
  }

  function handleMouseUp(event: MouseEvent): void {
    void event;
    if (!isMouseDown) return;

    // 停止主循环和所有相关状态
    isMouseDown = false;
    isDragSelecting = false;
    autoScrollDirection = 0;

    // 移除监听器和样式
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "";

    if (didDrag) {
      // 如果确实发生了拖拽，提交最终选择
      updateSelectionFromRectangle(true);
    }

    // 清理工作
    removeSelectionRect();
    startContainerRect = null;
    initialSelectedInDragOp.clear();
  }

  function handleClick(event: MouseEvent): void {
    // 如果是拖拽操作，则阻止后续的单击事件
    if (didDrag) {
      // --- START: MODIFICATION ---
      // 关键修复：在消耗掉拖拽状态后，立即将其重置。
      // 这可以防止这个状态影响到后续与拖拽无关的点击事件。
      didDrag = false;
      // --- END: MODIFICATION ---

      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = event.target as HTMLElement;
    if (!target.closest(EVENT_SCOPE_SELECTOR)) return;

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

  const originalFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = async (
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
      unsafeWindow,
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
            position: absolute; /* <-- 修改这里 */
                            top: 0; /* <-- 添加top和left以确保定位基准 */
                            left: 0;
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

  unsafeWindow.showBiliSelections = (mediaId: string | null = null): void => {
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

  unsafeWindow.removeBiliSelections = (
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
      unsafeWindow.TaskSelectorManager &&
      currentSelection &&
      currentSelection.length > 0
    ) {
      log(
        `BiliSelect init: Performing initial sync with TaskManager for ${currentSelection.length} selected BVs.`,
      );
      currentSelection.forEach((selectedBvId) => {
        // Ensure tasks for this BV are loaded in TaskManager first
        const folderName =
          unsafeWindow.folders?.get(currentMediaId) || "Unknown Folder";
        // Pass true here as well, these are selected in BiliSelect
        addSingleVideo(
          String(currentMediaId),
          folderName,
          selectedBvId,

          true,
        );
        unsafeWindow.TaskSelectorManager!.selectTasksByBv(
          selectedBvId,
          true,
          true,
        );
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runInitialization);
  } else {
    runInitialization();
  }
}
