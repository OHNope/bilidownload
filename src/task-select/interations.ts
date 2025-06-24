export function createDragHandler(options: {
  triggerElement: HTMLElement;
  movableElement: HTMLElement;
  state: { top: string; left: string };
  onDragStart?: () => void;
  onDragEnd?: () => void;
}): () => void {
  const { triggerElement, movableElement, state, onDragStart, onDragEnd } =
    options;
  let dragOffset = { x: 0, y: 0 };
  let isDragging = false;

  const handleMouseMove = (event: MouseEvent) => {
    if (!isDragging) return;
    event.preventDefault();
    let newTop = event.clientY - dragOffset.y;
    let newLeft = event.clientX - dragOffset.x;
    newTop = Math.max(
      0,
      Math.min(newTop, unsafeWindow.innerHeight - movableElement.offsetHeight),
    );
    newLeft = Math.max(
      0,
      Math.min(newLeft, unsafeWindow.innerWidth - movableElement.offsetWidth),
    );
    movableElement.style.top = `${newTop}px`;
    movableElement.style.left = `${newLeft}px`;
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    state.top = movableElement.style.top;
    state.left = movableElement.style.left;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    triggerElement.style.cursor = "grab";
    onDragEnd?.();
  };

  const handleMouseDown = (event: MouseEvent) => {
    if (
      (event.target as HTMLElement).closest(
        "button, .task-selector-collapse-indicator, .task-progress-close-btn, .task-progress-resizer",
      )
    ) {
      return;
    }
    isDragging = true;
    const rect = movableElement.getBoundingClientRect();
    dragOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    document.addEventListener("mousemove", handleMouseMove, {
      passive: false,
    });
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    triggerElement.style.cursor = "grabbing";
    onDragStart?.();
  };

  triggerElement.addEventListener("mousedown", handleMouseDown);
  return () => {
    triggerElement.removeEventListener("mousedown", handleMouseDown);
  };
}

export function createResizeHandler(options: {
  resizeHandleElement: HTMLElement;
  resizableElement: HTMLElement;
  state: { width: string; height: string };
  onResize?: () => void;
  onResizeEnd?: () => void;
}): () => void {
  const {
    resizeHandleElement,
    resizableElement,
    state,
    onResize,
    onResizeEnd,
  } = options;
  let startPos = { x: 0, y: 0, width: 0, height: 0 };
  let isResizing = false;

  const handleMouseMove = (event: MouseEvent) => {
    if (!isResizing) return;
    event.preventDefault();
    const dx = event.clientX - startPos.x;
    const dy = event.clientY - startPos.y;
    const style = getComputedStyle(resizableElement);
    const minW = parseInt(style.minWidth) || 100;
    const minH = parseInt(style.minHeight) || 70;
    let newWidth = Math.max(minW, startPos.width + dx);
    let newHeight = Math.max(minH, startPos.height + dy);
    resizableElement.style.width = `${newWidth}px`;
    resizableElement.style.height = `${newHeight}px`;
    onResize?.();
  };

  const handleMouseUp = () => {
    if (!isResizing) return;
    isResizing = false;
    state.width = resizableElement.style.width;
    state.height = resizableElement.style.height;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    onResizeEnd?.();
  };

  const handleMouseDown = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    isResizing = true;
    startPos = {
      x: event.clientX,
      y: event.clientY,
      width: resizableElement.offsetWidth,
      height: resizableElement.offsetHeight,
    };
    document.addEventListener("mousemove", handleMouseMove, {
      passive: false,
    });
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "nwse-resize";
  };

  resizeHandleElement.addEventListener("mousedown", handleMouseDown);
  return () => {
    resizeHandleElement.removeEventListener("mousedown", handleMouseDown);
  };
}
