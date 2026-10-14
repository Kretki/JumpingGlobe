/** Status line under the timeline: why plates or detail are not shown. */

import lodSettings from "../../lod.json";
import { lodFileFromHeight, WORLD_FILE } from "../land/lod.config";

const PREP_LOG_PATH = `${lodSettings.dataDir}/${lodSettings.plateModel.tag}_prep.log`;

export type TimelineStatusInput = {
  rotationModelError: boolean;
  buildStatus: string;
  statusDetail: string;
  plateFiles: Record<string, string>;
  hiddenPlateGroups: number;
  /** Why plate outlines or tectonic layers are not shown yet ("" when fine or not requested). */
  outlinesNote: string;
  ageInMyr: number;
  cameraHeightM: number;
  isPlaying: boolean;
};

/**
 * Compose the timeline status text.
 *
 * Usage: whenever age, plate status or zoom changes.
 *
 * @param statusInput - Current state.
 * @returns Notes joined by " · " ("" when everything is fine).
 */
export function timelineStatusText(statusInput: TimelineStatusInput): string {
  const statusNotes: string[] = [];
  if (statusInput.rotationModelError) {
    statusNotes.push("Rotation model unavailable — is the API server running (npm run server)?");
  } else if (statusInput.buildStatus === "failed" || statusInput.buildStatus === "unavailable") {
    statusNotes.push(
      `Plate layers unavailable: ${statusInput.statusDetail || statusInput.buildStatus} (see ${PREP_LOG_PATH})`
    );
  } else if (!statusInput.plateFiles[WORLD_FILE]) {
    statusNotes.push("Preparing plate layers…");
  }
  if (statusInput.outlinesNote) statusNotes.push(statusInput.outlinesNote);
  if (statusInput.hiddenPlateGroups > 0 && statusInput.ageInMyr > 0) {
    statusNotes.push("Some plates have no rotation poles at this age (hidden)");
  }
  if (statusInput.ageInMyr > 0) {
    const lodFileName = lodFileFromHeight(statusInput.cameraHeightM);
    if (lodFileName !== WORLD_FILE) {
      if (statusInput.isPlaying) statusNotes.push("Pause to load detail at this age");
      else if (!statusInput.plateFiles[lodFileName]) {
        statusNotes.push(`Detail for this zoom in the past is still being prepared (${lodFileName})`);
      }
    }
  }
  return statusNotes.join(" · ");
}
