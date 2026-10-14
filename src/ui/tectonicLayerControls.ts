/** The tectonic layer checkboxes: plate boundaries, plate motion, subducting plates and plate events. */

import type { TectonicLayerChoice } from "../plates/symbols/tectonicScene";

export type TectonicLayerElements = {
  boundariesCheckbox: HTMLInputElement;
  motionCheckbox: HTMLInputElement;
  subductingCheckbox: HTMLInputElement;
  eventsCheckbox: HTMLInputElement;
};

export class TectonicLayerControls implements TectonicLayerChoice {
  /**
   * Bind the checkboxes.
   *
   * Usage: once at start-up.
   *
   * @param layerElements - The four checkboxes.
   * @param onChange - Called after any of them changes.
   */
  constructor(
    private readonly layerElements: TectonicLayerElements,
    onChange: () => void
  ) {
    for (const layerCheckbox of Object.values(layerElements)) layerCheckbox.addEventListener("change", onChange);
  }

  /**
   * Whether ridges, subduction zones and transforms are drawn.
   *
   * Usage: tectonics controller.
   *
   * @returns True when "Plate boundaries" is ticked.
   */
  get showBoundaries(): boolean {
    return this.layerElements.boundariesCheckbox.checked;
  }

  /**
   * Whether plate-motion ticks are drawn.
   *
   * Usage: tectonics controller.
   *
   * @returns True when "Plate motion" is ticked.
   */
  get showMotion(): boolean {
    return this.layerElements.motionCheckbox.checked;
  }

  /**
   * Whether plates being subducted are shaded.
   *
   * Usage: tectonics controller.
   *
   * @returns True when "Subducting plates" is ticked.
   */
  get showSubducting(): boolean {
    return this.layerElements.subductingCheckbox.checked;
  }

  /**
   * Whether plate appearances and disappearances are shown.
   *
   * Usage: tectonics controller.
   *
   * @returns True when "Plate events" is ticked.
   */
  get showEvents(): boolean {
    return this.layerElements.eventsCheckbox.checked;
  }
}
