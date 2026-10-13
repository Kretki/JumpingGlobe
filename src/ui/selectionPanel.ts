/** "Selected point" panel (bottom right). */

export type SelectionPanelElements = {
  panelElement: HTMLElement;
  plateElement: HTMLElement;
  presentElement: HTMLElement;
  ageLabelElement: HTMLElement;
  positionElement: HTMLElement;
  trackElement: HTMLElement;
  noteElement: HTMLElement;
  clearButton: HTMLButtonElement;
};

/** Texts shown for a selection. */
export type SelectionPanelTexts = {
  plateText: string;
  presentText: string;
  ageLabel: string;
  positionText: string;
  trackText: string;
};

export class SelectionPanel {
  /**
   * Bind the panel and its Clear button / Escape key.
   *
   * Usage: once at start-up.
   *
   * @param panelElements - Panel elements.
   * @param onClearRequest - Called when the user clears the selection.
   */
  constructor(
    private readonly panelElements: SelectionPanelElements,
    onClearRequest: () => void
  ) {
    panelElements.clearButton.addEventListener("click", () => onClearRequest());
    window.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Escape") onClearRequest();
    });
  }

  /**
   * Show the panel with the given texts (all set as plain text).
   *
   * Usage: after a selection or when the age changes.
   *
   * @param panelTexts - Field values.
   * @param noteText - Note line ("" hides it); undefined keeps the current note.
   * @returns Nothing.
   */
  showDetails(panelTexts: SelectionPanelTexts, noteText?: string): void {
    const panelElements = this.panelElements;
    panelElements.panelElement.hidden = false;
    panelElements.plateElement.textContent = panelTexts.plateText;
    panelElements.presentElement.textContent = panelTexts.presentText;
    panelElements.ageLabelElement.textContent = panelTexts.ageLabel;
    panelElements.positionElement.textContent = panelTexts.positionText;
    panelElements.trackElement.textContent = panelTexts.trackText;
    if (noteText !== undefined) panelElements.noteElement.textContent = noteText;
  }

  /**
   * Show the panel with only a note (other fields keep their text; plate shows "—").
   *
   * Usage: static polygons are not ready yet.
   *
   * @param noteText - Note to show.
   * @returns Nothing.
   */
  showNote(noteText: string): void {
    this.panelElements.panelElement.hidden = false;
    this.panelElements.plateElement.textContent = "—";
    this.panelElements.noteElement.textContent = noteText;
  }

  /**
   * Reveal the panel without changing its content.
   *
   * Usage: a click started a lookup.
   *
   * @returns Nothing.
   */
  revealPanel(): void {
    this.panelElements.panelElement.hidden = false;
  }

  /**
   * Hide the panel and clear its note.
   *
   * Usage: selection cleared.
   *
   * @returns Nothing.
   */
  hidePanel(): void {
    this.panelElements.panelElement.hidden = true;
    this.panelElements.noteElement.textContent = "";
  }
}
