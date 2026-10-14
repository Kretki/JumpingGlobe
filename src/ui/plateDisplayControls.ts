/** The "Plate outlines" and "Plate names" checkboxes. */

export type PlateDisplayElements = {
  outlinesCheckbox: HTMLInputElement;
  namesCheckbox: HTMLInputElement;
};

/** Read-only view of the user's plate display choices. */
export interface PlateDisplayChoice {
  readonly showOutlines: boolean;
  readonly showNames: boolean;
}

export class PlateDisplayControls implements PlateDisplayChoice {
  /**
   * Bind the checkboxes.
   *
   * Usage: once at start-up. "Plate names" labels the outlined plates, so it is
   * only enabled while "Plate outlines" is ticked (its own tick is kept).
   *
   * @param displayElements - The two checkboxes.
   * @param onChange - Called after either checkbox changes.
   */
  constructor(
    private readonly displayElements: PlateDisplayElements,
    onChange: () => void
  ) {
    const handleChange = () => {
      this.syncEnabledState();
      onChange();
    };
    displayElements.outlinesCheckbox.addEventListener("change", handleChange);
    displayElements.namesCheckbox.addEventListener("change", handleChange);
    this.syncEnabledState();
  }

  /**
   * Enable "Plate names" only while outlines are shown.
   *
   * Usage: start-up and every change.
   *
   * @returns Nothing.
   */
  private syncEnabledState(): void {
    this.displayElements.namesCheckbox.disabled = !this.displayElements.outlinesCheckbox.checked;
  }

  /**
   * Whether the plate wireframe is wanted.
   *
   * Usage: outline controller, every frame.
   *
   * @returns True when "Plate outlines" is ticked.
   */
  get showOutlines(): boolean {
    return this.displayElements.outlinesCheckbox.checked;
  }

  /**
   * Whether plate names are wanted.
   *
   * Usage: outline controller, every frame.
   *
   * @returns True when both checkboxes are ticked.
   */
  get showNames(): boolean {
    return this.showOutlines && this.displayElements.namesCheckbox.checked;
  }
}
