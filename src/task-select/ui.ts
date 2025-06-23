import { states } from "./states";

export function closeProgressWindow(windowId: string): void {
  const pw = states.progressWindows[windowId];
  if (!pw?.element) return;
  pw.cleanupFunctions.forEach((cleanup) => cleanup());
  pw.listElement?.removeEventListener("scroll", pw.handleScroll);
  pw.element.remove();
  delete states.progressWindows[windowId];
}
