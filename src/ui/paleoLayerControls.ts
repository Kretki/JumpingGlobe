/**
 * Paleomagnetic layer controls: TPW poles, TPW grid, the TPW path (mantle frame), magnetic
 * poles, field lines and the number of field-line shells. A checkbox whose data does not cover the displayed age is
 * greyed out (disabled) but keeps its ticked or unticked state.
 */

import type { PaleoLayerChoice } from "../paleomag/paleoScene";

export type PaleoLayerElements = {
  spinAxisCheckbox: HTMLInputElement;
  paleoGridCheckbox: HTMLInputElement;
  tpwFrameSelect: HTMLSelectElement;
  magneticPolesCheckbox: HTMLInputElement;
  fieldLinesCheckbox: HTMLInputElement;
  shellCountSelect: HTMLSelectElement;
  tpwNoteElement: HTMLElement;
  magneticNoteElement: HTMLElement;
};

const MAX_SHELL_COUNT = 3;

export class PaleoLayerControls implements PaleoLayerChoice {
  /**
   * Bind the controls; everything starts greyed out until data is known.
   *
   * Usage: once at start-up.
   *
   * @param layerElements - Checkboxes, shell-count select and note elements.
   * @param onChange - Called after any control changes.
   */
  constructor(
    private readonly layerElements: PaleoLayerElements,
    onChange: () => void
  ) {
    const { tpwNoteElement, magneticNoteElement, ...inputElements } = layerElements;
    for (const inputElement of Object.values(inputElements)) inputElement.addEventListener("change", onChange);
    this.setAvailability(false, false);
    tpwNoteElement.textContent = "";
    magneticNoteElement.textContent = "";
  }

  /**
   * Whether the TPW spin-axis rods are ticked.
   *
   * Usage: scene builder.
   *
   * @returns The checkbox state (also while greyed out).
   */
  get showSpinAxis(): boolean {
    return this.layerElements.spinAxisCheckbox.checked;
  }

  /**
   * Whether the TPW latitude/longitude grid is ticked.
   *
   * Usage: scene builder.
   *
   * @returns The checkbox state.
   */
  get showPaleoGrid(): boolean {
    return this.layerElements.paleoGridCheckbox.checked;
  }

  /**
   * Whether the magnetic pole markers are ticked.
   *
   * Usage: scene builder.
   *
   * @returns The checkbox state.
   */
  get showMagneticPoles(): boolean {
    return this.layerElements.magneticPolesCheckbox.checked;
  }

  /**
   * Whether the magnetic field lines are ticked.
   *
   * Usage: scene builder.
   *
   * @returns The checkbox state.
   */
  get showFieldLines(): boolean {
    return this.layerElements.fieldLinesCheckbox.checked;
  }

  /**
   * Key of the TPW path chosen in the dropdown.
   *
   * Usage: TPW frame lookup.
   *
   * @returns The option value ("" before the options are known).
   */
  get tpwFrameKey(): string {
    return this.layerElements.tpwFrameSelect.value;
  }

  /**
   * Fill the TPW path dropdown (text only, never HTML).
   *
   * Usage: once when the paleomagnetic data arrived.
   *
   * @param frameOptions - Paths in display order; the first one is selected.
   * @returns Nothing.
   */
  setTpwFrameOptions(frameOptions: { frameKey: string; frameLabel: string }[]): void {
    const optionElements = frameOptions.map((frameOption) => {
      const optionElement = document.createElement("option");
      optionElement.value = frameOption.frameKey;
      optionElement.textContent = frameOption.frameLabel;
      return optionElement;
    });
    this.layerElements.tpwFrameSelect.replaceChildren(...optionElements);
    this.layerElements.tpwFrameSelect.disabled = optionElements.length < 2;
  }

  /**
   * Number of field-line shells chosen in the dropdown.
   *
   * Usage: scene builder.
   *
   * @returns 1..3.
   */
  get fieldShellCount(): number {
    const selectedCount = Number.parseInt(this.layerElements.shellCountSelect.value, 10);
    return Number.isFinite(selectedCount) ? Math.min(MAX_SHELL_COUNT, Math.max(1, selectedCount)) : 1;
  }

  /**
   * Grey out the controls whose data does not cover the displayed age.
   *
   * Usage: whenever the age changes; disabled checkboxes keep their state.
   *
   * @param tpwAvailable - TPW rotations cover the age.
   * @param magneticAvailable - At least one paleomagnetic pole covers the age.
   * @returns Nothing.
   */
  setAvailability(tpwAvailable: boolean, magneticAvailable: boolean): void {
    const { spinAxisCheckbox, paleoGridCheckbox, magneticPolesCheckbox, fieldLinesCheckbox, shellCountSelect } = this.layerElements;
    spinAxisCheckbox.disabled = !tpwAvailable;
    paleoGridCheckbox.disabled = !tpwAvailable;
    magneticPolesCheckbox.disabled = !magneticAvailable;
    fieldLinesCheckbox.disabled = !magneticAvailable;
    shellCountSelect.disabled = !magneticAvailable;
  }

  /**
   * Show what the data covers (text only).
   *
   * Usage: whenever the age changes.
   *
   * @param tpwNoteText - Note under the TPW checkboxes.
   * @param magneticNote - Note under the magnetic checkboxes.
   * @returns Nothing.
   */
  setNotes(tpwNoteText: string, magneticNote: string): void {
    this.layerElements.tpwNoteElement.textContent = tpwNoteText;
    this.layerElements.magneticNoteElement.textContent = magneticNote;
  }
}
