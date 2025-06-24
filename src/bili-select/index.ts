import { BiliSelectScriptAPI_Interface } from "../core/types";
import { addSingleVideo, InjectedStyles } from "../core/utils";

export class BiliSelectManager {
  // --- Constants and Selectors (Private) ---
  #LOG_PREFIX = "[BiliSelectScript V3]";
  #VIDEO_CARD_SELECTOR = ".bili-video-card__wrap";
  #LINK_SELECTOR = "a.bili-cover-card, .bili-video-card__title a";
  #SELECTED_CLASS = "custom-card-selected-highlight-v3";
  #SELECTION_RECT_ID = "custom-selection-rectangle-v3";
  #DRAG_THRESHOLD = 5;
  #API_URL_PATTERN = /api\.bilibili\.com\/x\/v3\/fav\/resource\/list/;
  #EVENT_SCOPE_SELECTOR = ".fav-list-main";
  #VIDEO_LIST_CONTAINER_SELECTOR = ".fav-list-main";
  #AUTO_SCROLL_ZONE_SIZE = 60;
  #AUTO_SCROLL_SPEED_MAX = 20;

  // --- State Management (Private) ---
  #selectionStorage: Record<string, string[]> = {};
  #currentMediaId: string;
  #isMouseDown = false;
  #didDrag = false;
  #isDragSelecting = false;
  #selectionRectElement: HTMLDivElement | null = null;
  #videoListContainer: HTMLElement | null = null;
  #lastClientX = 0;
  #lastClientY = 0;
  #autoScrollDirection = 0;
  #startScrollTop = 0;
  #selectionBoxStart = { x: 0, y: 0 };
  #initialSelectedInDragOp = new Set<string>();
  #observer: MutationObserver;
  #originalFetch: typeof window.fetch;

  constructor(initialMediaId: string) {
    "use strict";
    this.#currentMediaId = initialMediaId;
    this.#originalFetch = unsafeWindow.fetch;

    if (!this.#selectionStorage[this.#currentMediaId]) {
      this.#selectionStorage[this.#currentMediaId] = [];
    }

    this.#observer = new MutationObserver(this.#observerCallback.bind(this));

    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        this.#runInitialization.bind(this),
      );
    } else {
      this.#runInitialization();
    }
  }

  // --- Public API Methods ---
  public selectVideoCardByBv(
    bvId: string,
    shouldSelect: boolean,
    originatingFromTaskManager: boolean = false,
    originMediaId: string | null = null,
  ): void {
    this.#log(
      `BiliSelectScriptAPI.selectVideoCardByBv called for BV: ${bvId}, select: ${shouldSelect}, fromTaskMgr: ${originatingFromTaskManager}`,
    );

    if (!this.#selectionStorage[this.#currentMediaId]) {
      this.#selectionStorage[this.#currentMediaId] = [];
    }
    let currentSelection = this.#selectionStorage[this.#currentMediaId];

    const container = this.#findVideoListContainer();
    if (!container) {
      this.#log(
        "BiliSelectScriptAPI: Video list container not found for style update.",
      );
      const indexInCurrent = currentSelection.indexOf(bvId);
      if (shouldSelect && indexInCurrent === -1) {
        currentSelection.push(bvId);
      } else if (!shouldSelect && indexInCurrent > -1) {
        currentSelection.splice(indexInCurrent, 1);
      }
      this.#logState(
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
      if (index > -1) {
        currentSelection.splice(index, 1);
      } else {
        const originSelection = this.#selectionStorage[originMediaId!];
        originSelection?.splice(originSelection.indexOf(bvId), 1);
      }
      cardStateChangedInStorage = true;
    }

    if (cardStateChangedInStorage) {
      this.#logState(
        `BiliSelectScriptAPI: BV ${bvId} selection updated in storage to ${shouldSelect}.`,
      );
    }

    const cards = container.querySelectorAll<HTMLElement>(
      this.#VIDEO_CARD_SELECTOR,
    );
    let visualChangeMade = false;
    cards.forEach((card) => {
      const cardBvId = this.#getBvId(card);
      if (cardBvId === bvId) {
        if (shouldSelect) {
          if (!card.classList.contains(this.#SELECTED_CLASS)) {
            this.#addSelectedStyle(card);
            visualChangeMade = true;
          }
        } else {
          if (card.classList.contains(this.#SELECTED_CLASS)) {
            this.#removeSelectedStyle(card);
            visualChangeMade = true;
          }
        }
      }
    });

    if (visualChangeMade) {
      this.#log(
        `BiliSelectScriptAPI: Visual style for BV ${bvId} updated on page.`,
      );
    }

    if (cardStateChangedInStorage && !visualChangeMade && !shouldSelect) {
      this.#log(
        `BiliSelectScriptAPI: BV ${bvId} was deselected in storage, but no matching card found in current DOM to remove style.`,
      );
    }
  }

  public isBvSelected(bvId: string): boolean {
    const currentSelection = this.#selectionStorage[this.#currentMediaId];
    return currentSelection ? currentSelection.includes(bvId) : false;
  }

  // --- Private Internal Methods ---
  #log(...args: any[]): void {
    console.log(this.#LOG_PREFIX, ...args);
  }

  #logState(message: string = ""): void {
    if (message) this.#log(message);
    const currentSelection =
      this.#selectionStorage[this.#currentMediaId] || [];
    this.#log(`Current Media ID: ${this.#currentMediaId}`);
    const selectionPreview =
      currentSelection.length > 10
        ? [
          ...currentSelection.slice(0, 10),
          `... (${currentSelection.length - 10} more)`,
        ]
        : [...currentSelection];
    this.#log(
      `Current Selection (${currentSelection.length} items):`,
      selectionPreview,
    );
  }

  #runInitialization(): void {
    this.#log(
      `Detected favlist page. Initial media_id (fid): ${this.#currentMediaId
      }. Initializing script.`,
    );
    InjectedStyles("bili-select-script-styles-v3", `
            .${this.#SELECTED_CLASS} {
                outline: 3px solid #00a1d6 !important;
                box-shadow: 0 0 10px rgba(0, 161, 214, 0.8) !important;
                border-radius: 6px;
                transform: translateZ(0);
                background-color: rgba(0, 161, 214, 0.03);
            }
            #${this.#SELECTION_RECT_ID} {
                position: absolute;
                top: 0;
                left: 0;
                border: 1px dashed #00a1d6;
                background-color: rgba(0, 161, 214, 0.15);
                z-index: 9999;
                pointer-events: none;
            }
        `)
    this.#setupEventListeners();
    this.#overrideFetch();
    this.#exposeApiToWindow();
    this.#startObserver();

    requestAnimationFrame(this.#applySelectionStylesToPage.bind(this));
    this.#logState("Initial state after page load for BiliSelectManager");
    this.#log(
      'API functions "showBiliSelections(mediaId?)" and "removeBiliSelections(mediaId, bvIdArray)" are available on the window object.',
    );
    this.#log("BiliSelectManager initialization complete.");

    this.#performInitialSync();
  }

  #performInitialSync(): void {
    const currentSelection =
      this.#selectionStorage[this.#currentMediaId] || [];
    if (
      unsafeWindow.TaskSelectorManager &&
      currentSelection &&
      currentSelection.length > 0
    ) {
      this.#log(
        `BiliSelect init: Performing initial sync with TaskManager for ${currentSelection.length} selected BVs.`,
      );
      currentSelection.forEach((selectedBvId) => {
        const folderName =
          unsafeWindow.folders?.get(this.#currentMediaId) || "Unknown Folder";
        addSingleVideo(
          String(this.#currentMediaId),
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

  #setupEventListeners(): void {
    document.addEventListener("mousedown", this.#handleMouseDown.bind(this), false);
    document.addEventListener("click", this.#handleClick.bind(this), true);
  }

  #exposeApiToWindow(): void {
    const BiliSelectScriptAPI: BiliSelectScriptAPI_Interface = {
      selectVideoCardByBv: this.selectVideoCardByBv.bind(this),
      isBvSelected: this.isBvSelected.bind(this),
    };
    unsafeWindow.BiliSelectScriptAPI = BiliSelectScriptAPI;
    unsafeWindow.showBiliSelections = this.#showBiliSelections.bind(this);
    unsafeWindow.removeBiliSelections = this.#removeBiliSelections.bind(this);
  }

  #getBvId(element: HTMLElement | null): string | null {
    if (!element) return null;
    const cardRoot = element.closest<HTMLElement>(this.#VIDEO_CARD_SELECTOR);
    if (!cardRoot) return null;
    const linkElement = cardRoot.querySelector<HTMLAnchorElement>(this.#LINK_SELECTOR);
    if (linkElement?.href) {
      const match = linkElement.href.match(/BV([a-zA-Z0-9]+)/);
      return match ? match[0] : null;
    }
    return null;
  }

  #addSelectedStyle(element: HTMLElement | null): void {
    if (element) element.classList.add(this.#SELECTED_CLASS);
  }

  #removeSelectedStyle(element: HTMLElement | null): void {
    if (element) element.classList.remove(this.#SELECTED_CLASS);
  }

  #toggleSelection(element: HTMLElement): void {
    const bvId = this.#getBvId(element);
    if (!bvId || !this.#currentMediaId) return;

    if (!this.#selectionStorage[this.#currentMediaId]) {
      this.#log(
        `Error: Selection array for ${this.#currentMediaId} missing. Recreating.`,
      );
      this.#selectionStorage[this.#currentMediaId] = [];
    }
    const currentSelection = this.#selectionStorage[this.#currentMediaId];

    const index = currentSelection.indexOf(bvId);
    let isNowSelected: boolean;

    if (index > -1) {
      currentSelection.splice(index, 1);
      this.#removeSelectedStyle(element);
      isNowSelected = false;
      this.#logState(`Deselected: ${bvId} (user action)`);
    } else {
      currentSelection.push(bvId);
      this.#addSelectedStyle(element);
      isNowSelected = true;
      this.#logState(`Selected: ${bvId} (user action)`);
      if (unsafeWindow.TaskSelectorManager) {
        const folderName =
          unsafeWindow.folders?.get(this.#currentMediaId) || "Unknown Folder";
        addSingleVideo(String(this.#currentMediaId), folderName, bvId!, true);
      }
    }

    if (unsafeWindow.TaskSelectorManager) {
      this.#log(
        `BiliSelect.toggleSelection: Calling TaskManager.selectTasksByBv for ${bvId}, select: ${isNowSelected}`,
      );
      unsafeWindow.TaskSelectorManager.selectTasksByBv(
        bvId,
        isNowSelected,
        true,
      );
    }
  }

  #findVideoListContainer(): HTMLElement | null {
    if (
      !this.#videoListContainer ||
      !document.body.contains(this.#videoListContainer)
    ) {
      this.#videoListContainer = document.querySelector<HTMLElement>(
        this.#VIDEO_LIST_CONTAINER_SELECTOR,
      );
    }
    return this.#videoListContainer;
  }

  #applySelectionStylesToPage(): void {
    if (!this.#currentMediaId) {
      this.#log("ApplyStyles: No currentMediaId set, skipping.");
      return;
    }
    if (!this.#selectionStorage.hasOwnProperty(this.#currentMediaId)) {
      this.#selectionStorage[this.#currentMediaId] = [];
    }
    const currentSelection = this.#selectionStorage[this.#currentMediaId];

    this.#log(
      `ApplyStyles: Applying styles for media_id: ${this.#currentMediaId
      } (Items stored: ${currentSelection.length})`,
    );

    const container = this.#findVideoListContainer();
    if (!container) {
      this.#log("ApplyStyles: Container not found, cannot apply styles.");
      return;
    }

    const cards = container.querySelectorAll<HTMLElement>(
      this.#VIDEO_CARD_SELECTOR,
    );
    let styledCount = 0;
    cards.forEach((card) => {
      const bvId = this.#getBvId(card);
      if (bvId) {
        if (currentSelection.includes(bvId)) {
          this.#addSelectedStyle(card);
          styledCount++;
        } else {
          this.#removeSelectedStyle(card);
        }
      } else {
        this.#removeSelectedStyle(card);
      }
    });
    this.#log(
      `ApplyStyles: Style application complete. ${styledCount} items styled.`,
    );
  }

  // --- Drag and Select Logic ---

  #handleMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (
      !target.closest(this.#EVENT_SCOPE_SELECTOR) ||
      event.button !== 0 ||
      target.closest(
        "a, button, input, .bili-card-dropdown, .bili-card-checkbox, .bili-card-watch-later",
      )
    ) {
      return;
    }

    this.#isMouseDown = true;
    this.#didDrag = false;
    this.#isDragSelecting = true;

    this.#lastClientX = event.clientX;
    this.#lastClientY = event.clientY;
    this.#selectionBoxStart = { x: event.clientX, y: event.clientY };
    this.#startScrollTop =
      unsafeWindow.pageYOffset || document.documentElement.scrollTop;

    this.#initialSelectedInDragOp.clear();
    const currentSelection =
      this.#selectionStorage[this.#currentMediaId] || [];
    currentSelection.forEach((bvId) => this.#initialSelectedInDragOp.add(bvId));

    this.#removeSelectionRect();
    this.#selectionRectElement = document.createElement("div");
    this.#selectionRectElement.id = this.#SELECTION_RECT_ID;
    document.body.appendChild(this.#selectionRectElement);
    this.#selectionRectElement.style.display = "block";

    document.addEventListener("mousemove", this.#handleMouseMove.bind(this), {
      passive: false,
    });
    document.addEventListener("mouseup", this.#handleMouseUp.bind(this));
    document.body.style.userSelect = "none";
    requestAnimationFrame(this.#tickDragSelectionLoop.bind(this));
  }

  #handleMouseMove(event: MouseEvent): void {
    if (!this.#isMouseDown) return;
    event.preventDefault();

    if (!this.#didDrag) {
      const dx = Math.abs(event.clientX - this.#selectionBoxStart.x);
      const dy = Math.abs(event.clientY - this.#selectionBoxStart.y);
      if (dx > this.#DRAG_THRESHOLD || dy > this.#DRAG_THRESHOLD) {
        this.#didDrag = true;
      }
    }

    this.#lastClientX = event.clientX;
    this.#lastClientY = event.clientY;

    let scrollDirection = 0;
    if (this.#lastClientY < this.#AUTO_SCROLL_ZONE_SIZE) {
      scrollDirection = -1;
    } else if (
      this.#lastClientY >
      unsafeWindow.innerHeight - this.#AUTO_SCROLL_ZONE_SIZE
    ) {
      scrollDirection = 1;
    }
    this.#autoScrollDirection = scrollDirection;
  }

  #handleMouseUp(event: MouseEvent): void {
    if (!this.#isMouseDown) return;

    this.#isMouseDown = false;
    this.#isDragSelecting = false;
    this.#autoScrollDirection = 0;

    document.removeEventListener("mousemove", this.#handleMouseMove.bind(this));
    document.removeEventListener("mouseup", this.#handleMouseUp.bind(this));
    document.body.style.userSelect = "";

    if (this.#didDrag) {
      this.#updateSelectionFromRectangle(true);
    }

    this.#removeSelectionRect();
    this.#initialSelectedInDragOp.clear();
  }

  #handleClick(event: MouseEvent): void {
    if (this.#didDrag) {
      this.#didDrag = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const target = event.target as HTMLElement;
    if (!target.closest(this.#EVENT_SCOPE_SELECTOR)) return;
    const targetCard = target.closest<HTMLElement>(this.#VIDEO_CARD_SELECTOR);
    if (
      !targetCard ||
      target.closest(
        "a, button, input, .bili-card-dropdown, .bili-card-checkbox, .bili-card-watch-later",
      )
    )
      return;

    this.#toggleSelection(targetCard);
  }

  #tickDragSelectionLoop(): void {
    if (!this.#isDragSelecting) return;

    if (this.#autoScrollDirection !== 0) {
      unsafeWindow.scrollBy(
        0,
        this.#AUTO_SCROLL_SPEED_MAX * this.#autoScrollDirection,
      );
    }

    this.#updateSelectionRectangleVisuals();
    this.#updateSelectionFromRectangle(false);
    requestAnimationFrame(this.#tickDragSelectionLoop.bind(this));
  }

  #updateSelectionRectangleVisuals(): void {
    if (!this.#selectionRectElement) return;

    const scrollX =
      unsafeWindow.pageXOffset || document.documentElement.scrollLeft;
    const scrollY =
      unsafeWindow.pageYOffset || document.documentElement.scrollTop;

    const anchorX = this.#selectionBoxStart.x + scrollX;
    const anchorY = this.#selectionBoxStart.y + this.#startScrollTop;

    const activeX = this.#lastClientX + scrollX;
    const activeY = this.#lastClientY + scrollY;

    Object.assign(this.#selectionRectElement.style, {
      top: `${Math.min(anchorY, activeY)}px`,
      left: `${Math.min(anchorX, activeX)}px`,
      height: `${Math.abs(anchorY - activeY)}px`,
      width: `${Math.abs(anchorX - activeX)}px`,
    });
  }

  #updateSelectionFromRectangle(isFinal: boolean = false): void {
    if (!this.#selectionRectElement) return;

    const rectBounds = this.#selectionRectElement.getBoundingClientRect();
    const container = this.#findVideoListContainer();
    if (!container) return;

    const cards = container.querySelectorAll<HTMLElement>(
      this.#VIDEO_CARD_SELECTOR,
    );
    if (cards.length === 0) return;

    if (isFinal) {
      let changed = false;
      cards.forEach((card) => {
        const bvId = this.#getBvId(card);
        if (!bvId) return;

        const isNowSelected = card.classList.contains(this.#SELECTED_CLASS);
        const wasOriginallySelected = this.#initialSelectedInDragOp.has(bvId);

        if (isNowSelected !== wasOriginallySelected) {
          changed = true;
          card.classList.toggle(this.#SELECTED_CLASS);
          this.#toggleSelection(card);
        }
      });
      if (changed) this.#logState("Selection updated via drag");
    } else {
      cards.forEach((card) => {
        const bvId = this.#getBvId(card);
        if (!bvId) return;

        let shouldBeSelectedNow: boolean;
        if (this.#isIntersecting(card, rectBounds)) {
          shouldBeSelectedNow = !this.#initialSelectedInDragOp.has(bvId);
        } else {
          shouldBeSelectedNow = this.#initialSelectedInDragOp.has(bvId);
        }

        if (shouldBeSelectedNow) {
          this.#addSelectedStyle(card);
        } else {
          this.#removeSelectedStyle(card);
        }

        if (unsafeWindow.TaskSelectorManager) {
          unsafeWindow.TaskSelectorManager.selectTasksByBv(
            bvId,
            shouldBeSelectedNow,
            true,
          );
        }
      });
    }
  }

  #removeSelectionRect(): void {
    if (this.#selectionRectElement) {
      this.#selectionRectElement.remove();
      this.#selectionRectElement = null;
    }
  }

  #isIntersecting(
    element: HTMLElement,
    rectBounds: DOMRectReadOnly,
  ): boolean {
    const elemRect = element.getBoundingClientRect();
    return !(
      elemRect.right < rectBounds.left ||
      elemRect.left > rectBounds.right ||
      elemRect.bottom < rectBounds.top ||
      elemRect.top > rectBounds.bottom
    );
  }

  // --- Network Interception and DOM Observation ---
  #overrideFetch(): void {
    unsafeWindow.fetch = async (
      ...args: [RequestInfo | URL, RequestInit?]
    ): Promise<Response> => {
      const url = args[0] instanceof Request ? args[0].url : String(args[0]);
      if (url && this.#API_URL_PATTERN.test(url)) {
        this.#log(`FETCH: Detected target API call: ${url}`);
        try {
          const urlParams = new URLSearchParams(url.split("?")[1]);
          const fetchMediaId = urlParams.get("media_id");

          if (fetchMediaId && fetchMediaId !== this.#currentMediaId) {
            this.#log(
              `FETCH: Media ID changing from ${this.#currentMediaId
              } to ${fetchMediaId}. Updating state...`,
            );
            this.#currentMediaId = fetchMediaId;
            if (!this.#selectionStorage.hasOwnProperty(this.#currentMediaId)) {
              this.#selectionStorage[this.#currentMediaId] = [];
            }
            this.#logState(
              `FETCH: Switched active context to media_id ${this.#currentMediaId
              }`,
            );
            requestAnimationFrame(this.#applySelectionStylesToPage.bind(this));
          }
        } catch (error: any) {
          this.#log("FETCH: Error parsing fetch URL parameters:", error.message);
        }
      }
      return this.#originalFetch.apply(unsafeWindow, args as any);
    };
  }

  #observerCallback(mutationsList: MutationRecord[]): void {
    for (const mutation of mutationsList) {
      if (mutation.type === "childList") {
        const hasRelevantNodes = (nodes: NodeList): boolean => {
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              ((node as HTMLElement).matches(this.#VIDEO_CARD_SELECTOR) ||
                (node as HTMLElement).querySelector(this.#VIDEO_CARD_SELECTOR))
            ) {
              return true;
            }
          }
          return false;
        };
        if (
          hasRelevantNodes(mutation.addedNodes) ||
          hasRelevantNodes(mutation.removedNodes)
        ) {
          this.#log("Observer: Relevant DOM change. Re-applying styles...");
          requestAnimationFrame(this.#applySelectionStylesToPage.bind(this));
          return; // Exit after first relevant change
        }
      }
    }
  }

  #startObserver(): void {
    const targetNode = this.#findVideoListContainer();
    if (targetNode) {
      this.#log(`Observer: Starting observer on:`, targetNode);
      const observerConfig: MutationObserverInit = {
        childList: true,
        subtree: true,
      };
      this.#observer.disconnect();
      this.#observer.observe(targetNode, observerConfig);
    } else {
      this.#log("Observer: Container not found. Retrying in 1s...");
      setTimeout(() => this.#startObserver(), 1000);
    }
  }

  // --- Window-Exposed Helper Functions ---
  #showBiliSelections(mediaId: string | null = null): void {
    console.log(`${this.#LOG_PREFIX} --- Inspecting Selection Storage ---`);
    if (mediaId) {
      if (this.#selectionStorage.hasOwnProperty(mediaId)) {
        console.log(
          `Selections for media_id "${mediaId}" (${this.#selectionStorage[mediaId].length
          } items):`,
        );
        console.table(this.#selectionStorage[mediaId].map((bv) => ({ BV_ID: bv })));
      } else {
        console.log(`No selection data found for media_id: ${mediaId}`);
      }
    } else {
      console.log("All tracked selections by media_id:");
      console.log(JSON.parse(JSON.stringify(this.#selectionStorage)));
    }
    console.log(`${this.#LOG_PREFIX} --- End Inspection ---`);
  }

  #removeBiliSelections(
    mediaId: string,
    bvIdsToRemove: string[],
  ): void {
    console.log(`${this.#LOG_PREFIX} --- Attempting Batch Removal ---`);
    if (!mediaId || !this.#selectionStorage.hasOwnProperty(mediaId)) {
      console.error(
        `${this.#LOG_PREFIX} Invalid or unknown media_id provided.`,
      );
      return;
    }
    if (!Array.isArray(bvIdsToRemove) || bvIdsToRemove.length === 0) {
      console.error(
        `${this.#LOG_PREFIX} Must provide a non-empty array of BV IDs to remove.`,
      );
      return;
    }

    const initialCount = this.#selectionStorage[mediaId].length;
    this.#selectionStorage[mediaId] = this.#selectionStorage[mediaId].filter(
      (bv) => !bvIdsToRemove.includes(bv),
    );
    const removedCount = initialCount - this.#selectionStorage[mediaId].length;
    this.#log(
      `Removal complete. ${removedCount} item(s) removed. Final count: ${this.#selectionStorage[mediaId].length
      }.`,
    );

    if (mediaId === this.#currentMediaId) {
      this.#log("Updating page visuals as the current list was modified.");
      requestAnimationFrame(this.#applySelectionStylesToPage.bind(this));
      this.#logState("State updated after batch removal");
    }
    console.log(`${this.#LOG_PREFIX} --- Removal Complete ---`);
  }
}