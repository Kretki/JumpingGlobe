/** Build the UI components from their DOM elements in index.html (fail-fast lookups). */

import { requireElement } from "./domLookup";
import { LandProgressPanel } from "./landProgressPanel";
import { PlateDisplayControls } from "./plateDisplayControls";
import { PlateLabelLayer } from "./plateLabelLayer";
import { SelectionPanel } from "./selectionPanel";
import { TimelineControl } from "./timelineControl";

/**
 * Create the timeline control from its DOM elements.
 *
 * Usage: start-up.
 *
 * @param onAgeChange - Called when the age changes.
 * @returns The control.
 */
export function createTimeline(onAgeChange: (ageInMyr: number) => void): TimelineControl {
  return new TimelineControl(
    {
      ageSlider: requireElement("tl-age", HTMLInputElement),
      ageReadout: requireElement("tl-readout", HTMLOutputElement),
      playButton: requireElement("tl-play", HTMLButtonElement),
      speedSelect: requireElement("tl-speed", HTMLSelectElement),
      reverseCheckbox: requireElement("tl-reverse", HTMLInputElement),
      startLabel: requireElement("tl-start", HTMLSpanElement),
      endLabel: requireElement("tl-end", HTMLSpanElement),
      statusElement: requireElement("tl-status", HTMLSpanElement),
    },
    onAgeChange
  );
}

/**
 * Create the land progress card from its DOM elements.
 *
 * Usage: start-up.
 *
 * @returns The panel.
 */
export function createProgressPanel(): LandProgressPanel {
  const panelElement = requireElement("land-progress", HTMLDivElement);
  const percentElement = panelElement.querySelector(".pct");
  if (!(percentElement instanceof HTMLElement)) throw new Error("#land-progress .pct is missing");
  return new LandProgressPanel({
    panelElement,
    fillElement: requireElement("land-progress-fill", HTMLElement),
    labelElement: requireElement("land-progress-label", HTMLDivElement),
    percentElement,
  });
}

/**
 * Create the selection panel from its DOM elements.
 *
 * Usage: start-up.
 *
 * @param onClearRequest - Called when the user clears the selection.
 * @returns The panel.
 */
export function createSelectionPanel(onClearRequest: () => void): SelectionPanel {
  return new SelectionPanel(
    {
      panelElement: requireElement("point-panel", HTMLElement),
      plateElement: requireElement("pp-plate", HTMLElement),
      presentElement: requireElement("pp-present", HTMLElement),
      ageLabelElement: requireElement("pp-age-label", HTMLElement),
      positionElement: requireElement("pp-at", HTMLElement),
      trackElement: requireElement("pp-track", HTMLElement),
      noteElement: requireElement("pp-note", HTMLElement),
      clearButton: requireElement("pp-clear", HTMLButtonElement),
    },
    onClearRequest
  );
}

/**
 * Create the plate display checkboxes.
 *
 * Usage: start-up.
 *
 * @param onChange - Called when either checkbox changes.
 * @returns The controls.
 */
export function createPlateDisplayControls(onChange: () => void): PlateDisplayControls {
  return new PlateDisplayControls(
    {
      outlinesCheckbox: requireElement("pl-outlines", HTMLInputElement),
      namesCheckbox: requireElement("pl-names", HTMLInputElement),
    },
    onChange
  );
}

/**
 * Create the plate-name label layer.
 *
 * Usage: start-up.
 *
 * @returns The layer.
 */
export function createPlateLabelLayer(): PlateLabelLayer {
  return new PlateLabelLayer(requireElement("plate-labels", HTMLDivElement));
}
