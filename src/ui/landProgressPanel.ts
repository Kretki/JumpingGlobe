/** "Land load" progress card in the top-right corner. */

import { clampValue } from "../geodesy/angleMath";

const HIDE_DELAY_MS = 900;

export type ProgressPanelElements = {
  panelElement: HTMLElement;
  fillElement: HTMLElement;
  labelElement: HTMLElement;
  percentElement: HTMLElement;
};

export class LandProgressPanel {
  private hideTimer = 0;

  /**
   * Bind the panel to its elements.
   *
   * Usage: once at start-up.
   *
   * @param panelElements - The card, its bar fill, label and percentage.
   */
  constructor(private readonly panelElements: ProgressPanelElements) {}

  /**
   * Show progress, hiding the card shortly after it reaches 100 %.
   *
   * Usage: from land loader progress callbacks.
   *
   * @param percentDone - Progress 0–100 (rounded and clamped).
   * @param labelText - Status line (rendered as text, never HTML).
   * @param isVisible - Whether the card should be shown.
   * @returns Nothing.
   */
  updateProgress(percentDone: number, labelText: string, isVisible: boolean): void {
    const shownPercent = clampValue(Math.round(percentDone), 0, 100);
    const { panelElement, fillElement, labelElement, percentElement } = this.panelElements;
    percentElement.textContent = `${shownPercent}%`;
    fillElement.style.width = `${shownPercent}%`;
    labelElement.textContent = labelText;
    if (isVisible) {
      panelElement.classList.add("visible");
      window.clearTimeout(this.hideTimer);
      if (shownPercent >= 100) {
        this.hideTimer = window.setTimeout(() => panelElement.classList.remove("visible"), HIDE_DELAY_MS);
      }
    } else if (shownPercent >= 100 || labelText === "Idle") {
      panelElement.classList.remove("visible");
    }
  }
}
