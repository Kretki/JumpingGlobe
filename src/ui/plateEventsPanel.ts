/** List of plate appearances and disappearances near the displayed age (text only, never HTML). */

import type { PlateEvent } from "../plates/topology/plateLifetimes";

const MARKER_BY_KIND = { appear: "▲", vanish: "▼" } as const;
const VERB_BY_KIND = { appear: "appears", vanish: "disappears" } as const;

export class PlateEventsPanel {
  /**
   * Bind the panel to its list element.
   *
   * Usage: once at start-up with ``#plate-events``.
   *
   * @param listElement - Element the event rows are written into.
   */
  constructor(private readonly listElement: HTMLElement) {
    listElement.hidden = true;
  }

  /**
   * Show the events around an age.
   *
   * Usage: whenever the age changes while "Plate events" is ticked.
   *
   * @param plateEvents - Events to list (see eventsNear).
   * @param ageInMyr - Displayed age; events before/after it are marked as past/future.
   * @returns Nothing.
   */
  showEvents(plateEvents: PlateEvent[], ageInMyr: number): void {
    const rowElements = plateEvents.map((plateEvent) => {
      const rowElement = document.createElement("li");
      rowElement.className = `plate-event plate-event--${plateEvent.eventKind}${plateEvent.eventAgeMa >= ageInMyr ? " plate-event--past" : ""}`;
      rowElement.textContent = `${MARKER_BY_KIND[plateEvent.eventKind]} ${plateEvent.eventAgeMa.toFixed(0)} Ma · ${plateEvent.plateName} ${VERB_BY_KIND[plateEvent.eventKind]}`;
      return rowElement;
    });
    if (!rowElements.length) {
      const emptyRow = document.createElement("li");
      emptyRow.className = "plate-event";
      emptyRow.textContent = "No plate appears or disappears near this age";
      rowElements.push(emptyRow);
    }
    this.listElement.replaceChildren(...rowElements);
    this.listElement.hidden = false;
  }

  /**
   * Hide the list.
   *
   * Usage: when "Plate events" is unticked.
   *
   * @returns Nothing.
   */
  hideEvents(): void {
    this.listElement.hidden = true;
  }
}
