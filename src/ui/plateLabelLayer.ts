/** DOM layer of plate-name labels over the canvas (text only, never HTML). */

import type { PlacedLabel } from "../rendering/labelPlacement";

const LABEL_CLASS = "plate-label";

export class PlateLabelLayer {
  private readonly labelElements: HTMLSpanElement[] = [];

  /**
   * Bind the layer to its container.
   *
   * Usage: once at start-up with the ``#plate-labels`` element (absolutely positioned
   * over the canvas, pointer-events disabled).
   *
   * @param containerElement - Container the label elements are created in.
   */
  constructor(private readonly containerElement: HTMLElement) {
    containerElement.hidden = true;
  }

  /**
   * Label element number ``labelIdx``, created on first use.
   *
   * Usage: renderLabels (elements are pooled and reused every frame).
   *
   * @param labelIdx - Index in the pool.
   * @returns The element.
   */
  private elementAt(labelIdx: number): HTMLSpanElement {
    let labelElement = this.labelElements[labelIdx];
    if (!labelElement) {
      labelElement = document.createElement("span");
      labelElement.className = LABEL_CLASS;
      this.containerElement.appendChild(labelElement);
      this.labelElements.push(labelElement);
    }
    return labelElement;
  }

  /**
   * Show exactly the given labels.
   *
   * Usage: every frame while plate names are on.
   *
   * @param placedLabels - Labels with their CSS-pixel centre (see placeLabels).
   * @returns Nothing; unused pooled elements are hidden.
   */
  renderLabels(placedLabels: PlacedLabel[]): void {
    this.containerElement.hidden = false;
    placedLabels.forEach((placedLabel, labelIdx) => {
      const labelElement = this.elementAt(labelIdx);
      if (labelElement.textContent !== placedLabel.labelText) labelElement.textContent = placedLabel.labelText;
      const styleClass = `${LABEL_CLASS} ${LABEL_CLASS}--${placedLabel.labelStyle}`;
      if (labelElement.className !== styleClass) labelElement.className = styleClass;
      labelElement.style.transform = `translate(${placedLabel.screenX.toFixed(1)}px, ${placedLabel.screenY.toFixed(1)}px) translate(-50%, -50%)`;
      labelElement.hidden = false;
    });
    for (let spareIdx = placedLabels.length; spareIdx < this.labelElements.length; spareIdx++) {
      this.labelElements[spareIdx].hidden = true;
    }
  }

  /**
   * Hide every label.
   *
   * Usage: when plate names or outlines are switched off.
   *
   * @returns Nothing.
   */
  hideLabels(): void {
    this.containerElement.hidden = true;
  }
}
