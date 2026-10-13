/** Click-to-select: which plate a point is on, where it is today, and its path through time. */

import type { StaticPolygon } from "../plates/staticPolygons";
import { findPlateAt } from "../plates/staticPolygons";
import { computeTrack, positionAt, type TrackedPoint } from "../plates/pointTrack";
import { unitToLonLat, type UnitVector } from "../plates/sphericalCoords";
import type { SelectionOverlay } from "../rendering/selectionOverlay";
import { formatLonLat } from "../ui/coordinateFormat";
import type { SelectionPanel } from "../ui/selectionPanel";
import type { AgeSource } from "../ui/timelineControl";
import { fetchStaticPolygons } from "./globeApi";
import type { PlateLayerTracker } from "./plateLayerTracker";

/** 0.25 Myr steps keep the line smooth even through fast (~2°/Myr) motion. */
const TRACK_STEP_MYR = 0.25;

type Selection = TrackedPoint & { maxTrackAge: number };

export type PointSelectionDeps = {
  plateTracker: PlateLayerTracker;
  ageSource: AgeSource;
  selectionPanel: SelectionPanel;
  selectionOverlay: SelectionOverlay;
};

/** Present-day and current-age positions to draw. */
export type SelectionMarkers = { presentUnit: UnitVector; currentUnit: UnitVector | null };

export class PointSelection {
  private staticList: StaticPolygon[] | null = null;
  private staticsLoading: Promise<StaticPolygon[] | null> | null = null;
  private selection: Selection | null = null;

  /**
   * Create the controller.
   *
   * Usage: once at start-up; the panel's Clear button should call clearSelection().
   *
   * @param selectionDeps - Collaborators.
   */
  constructor(private readonly selectionDeps: PointSelectionDeps) {}

  /**
   * Load the static polygons once (retried after failures).
   *
   * Usage: first selection.
   *
   * @returns Static polygons, or null while unavailable.
   */
  private loadStatics(): Promise<StaticPolygon[] | null> {
    if (this.staticList) return Promise.resolve(this.staticList);
    const staticFile = this.selectionDeps.plateTracker.staticFile;
    if (!staticFile) return Promise.resolve(null);
    if (!this.staticsLoading) {
      this.staticsLoading = fetchStaticPolygons(staticFile)
        .then((staticList) => (this.staticList = staticList))
        .catch((caughtError) => {
          console.warn("static polygons unavailable", caughtError);
          this.staticsLoading = null;
          return null;
        });
    }
    return this.staticsLoading;
  }

  /**
   * Remove the selection.
   *
   * Usage: Clear button / Escape.
   *
   * @returns Nothing.
   */
  clearSelection(): void {
    this.selection = null;
    this.selectionDeps.selectionPanel.hidePanel();
  }

  /**
   * Select the point under a click.
   *
   * Usage: click handler with the picked lon/lat.
   *
   * @param longitudeDeg - Clicked longitude (as displayed at the current age).
   * @param latitudeDeg - Clicked latitude.
   * @returns Resolves when the panel is updated.
   */
  async selectAt(longitudeDeg: number, latitudeDeg: number): Promise<void> {
    const rotationTree = this.selectionDeps.plateTracker.rotationTree;
    if (!rotationTree) return;
    const selectionPanel = this.selectionDeps.selectionPanel;
    selectionPanel.revealPanel();
    const staticList = await this.loadStatics();
    if (!staticList) {
      selectionPanel.showNote("Plate polygons are still being prepared — try again in a moment.");
      return;
    }
    const ageInMyr = this.selectionDeps.ageSource.currentAgeMa;
    const plateHit = findPlateAt(staticList, rotationTree, longitudeDeg, latitudeDeg, ageInMyr);
    if (!plateHit) {
      this.selection = null;
      selectionPanel.showDetails(
        {
          plateText: "none",
          presentText: "—",
          ageLabel: `At ${ageInMyr.toFixed(0)} Ma`,
          positionText: formatLonLat(longitudeDeg, latitudeDeg),
          trackText: "—",
        },
        "No plate in the model covers this point at this age."
      );
      return;
    }
    const staticPolygon = plateHit.staticPolygon;
    const maxTrackAge = Math.min(rotationTree.maxAgeMa, staticPolygon.appearAgeMa);
    this.selection = {
      plateNumber: staticPolygon.plateNumber,
      plateName: staticPolygon.plateName,
      appearAgeMa: staticPolygon.appearAgeMa,
      vanishAgeMa: staticPolygon.vanishAgeMa,
      presentUnit: plateHit.presentUnit,
      presentLon: plateHit.presentLon,
      presentLat: plateHit.presentLat,
      trackSamples: computeTrack(rotationTree, staticPolygon, plateHit.presentUnit, maxTrackAge, TRACK_STEP_MYR),
      maxTrackAge,
    };
    this.refreshPanel("");
    this.selectionDeps.selectionOverlay.uploadTrack(this.selection.trackSamples);
  }

  /**
   * Update the panel for the current age.
   *
   * Usage: after a selection and whenever the age changes.
   *
   * @param noteText - Note to set, or undefined to keep the current note.
   * @returns Nothing.
   */
  refreshPanel(noteText?: string): void {
    const rotationTree = this.selectionDeps.plateTracker.rotationTree;
    const selection = this.selection;
    if (!selection || !rotationTree) return;
    const ageInMyr = this.selectionDeps.ageSource.currentAgeMa;
    const currentUnit = positionAt(rotationTree, selection, selection.presentUnit, ageInMyr);
    let positionText: string;
    if (currentUnit) {
      const [currentLon, currentLat] = unitToLonLat(currentUnit);
      positionText = formatLonLat(currentLon, currentLat);
    } else {
      positionText = ageInMyr > selection.appearAgeMa ? "not formed yet" : "no rotation data";
    }
    const shownSamples = selection.trackSamples.filter((trackSample) => trackSample.unitVector).length;
    const hasTrackGaps = shownSamples < selection.trackSamples.length;
    this.selectionDeps.selectionPanel.showDetails(
      {
        plateText: `${selection.plateNumber}${selection.plateName ? ` · ${selection.plateName}` : ""}`,
        presentText: formatLonLat(selection.presentLon, selection.presentLat),
        ageLabel: `At ${ageInMyr.toFixed(0)} Ma`,
        positionText,
        trackText: shownSamples ? `0 – ${selection.maxTrackAge.toFixed(0)} Ma${hasTrackGaps ? " (gaps)" : ""}` : "—",
      },
      noteText
    );
  }

  /**
   * Positions of the selection's markers at the current age.
   *
   * Usage: overlay drawing every frame.
   *
   * @returns Markers, or null without a selection or rotation model.
   */
  currentMarkers(): SelectionMarkers | null {
    const rotationTree = this.selectionDeps.plateTracker.rotationTree;
    if (!this.selection || !rotationTree) return null;
    const ageInMyr = this.selectionDeps.ageSource.currentAgeMa;
    return {
      presentUnit: this.selection.presentUnit,
      currentUnit: positionAt(rotationTree, this.selection, this.selection.presentUnit, ageInMyr),
    };
  }
}
