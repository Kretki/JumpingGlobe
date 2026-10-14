/** One label layer shared by several label providers (plate names, tectonic annotations). */

import { placeLabels, type LabelRequest, type LabelView, type PlacedLabel } from "../rendering/labelPlacement";

/** Anything that wants labels on the globe this frame. */
export interface LabelProvider {
  labelRequests(): LabelRequest[];
}

/** Shows placed labels (PlateLabelLayer). */
export interface PlacedLabelSink {
  renderLabels(placedLabels: PlacedLabel[]): void;
  hideLabels(): void;
}

export class LabelBoard {
  /**
   * Combine providers into one label layer.
   *
   * Usage: once at start-up; earlier providers win label space when labels overlap.
   *
   * @param labelProviders - Providers in priority order.
   * @param labelSink - Layer that shows the placed labels.
   */
  constructor(
    private readonly labelProviders: LabelProvider[],
    private readonly labelSink: PlacedLabelSink
  ) {}

  /**
   * Place and show this frame's labels.
   *
   * Usage: every frame, after the providers updated.
   *
   * @param labelView - Camera and viewport of this frame.
   * @returns Nothing; hides the layer when no provider has labels.
   */
  renderFrame(labelView: LabelView): void {
    const labelRequests = this.labelProviders.flatMap((labelProvider) => labelProvider.labelRequests());
    if (!labelRequests.length) {
      this.labelSink.hideLabels();
      return;
    }
    this.labelSink.renderLabels(placeLabels(labelRequests, labelView));
  }
}
