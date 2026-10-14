/** Screen placement of globe labels: projection, far-side culling and overlap removal. */

import { writeSurfacePoint } from "../geodesy/wgs84Ellipsoid";
import type { UnitVector } from "../plates/sphericalCoords";
import type { Matrix4x4 } from "./matrixMath";

/** Visual kind of a label (CSS modifier): plain plate name or a tectonic annotation. */
export type LabelStyle = "plate" | "subducting" | "appear" | "vanish";

/** A label to place: text, its direction on the GPlates sphere and its style (default "plate"). */
export type LabelRequest = { labelText: string; labelUnit: UnitVector; labelStyle?: LabelStyle };

/** A placed label: text, style and the CSS-pixel position of its centre. */
export type PlacedLabel = { labelText: string; labelStyle: LabelStyle; screenX: number; screenY: number };

/** Camera and viewport of the frame the labels are placed for. */
export type LabelView = {
  modelViewProj: Matrix4x4;
  eyePosition: number[];
  /** Canvas size in CSS pixels. */
  viewportWidth: number;
  viewportHeight: number;
};

type ScreenRect = { leftEdge: number; topEdge: number; rightEdge: number; bottomEdge: number };

const MAX_PLACED_LABELS = 60;
const CHAR_WIDTH_PX = 7;
const LABEL_HEIGHT_PX = 16;
const LABEL_PADDING_PX = 10;
/** Labels whose surface normal is this close to perpendicular to the view are skipped (globe limb). */
const MIN_FACING_COSINE = 0.15;

/**
 * Whether a surface point faces the camera clearly enough to label.
 *
 * Usage: skip labels on the far side of the globe and on its limb.
 *
 * @param surfacePoint - ECEF position in metres.
 * @param surfaceNormal - Unit direction of the point (≈ ellipsoid normal).
 * @param eyePosition - Camera position (ECEF).
 * @returns True when the angle between normal and view direction is small enough.
 */
function facesCamera(surfacePoint: Float32Array, surfaceNormal: UnitVector, eyePosition: number[]): boolean {
  const viewVecX = eyePosition[0] - surfacePoint[0];
  const viewVecY = eyePosition[1] - surfacePoint[1];
  const viewVecZ = eyePosition[2] - surfacePoint[2];
  const viewLength = Math.hypot(viewVecX, viewVecY, viewVecZ) || 1;
  const facingCosine = (viewVecX * surfaceNormal[0] + viewVecY * surfaceNormal[1] + viewVecZ * surfaceNormal[2]) / viewLength;
  return facingCosine > MIN_FACING_COSINE;
}

/**
 * Project an ECEF point to CSS pixels.
 *
 * Usage: label positions.
 *
 * @param surfacePoint - ECEF position in metres.
 * @param labelView - Camera matrix and viewport size.
 * @returns [x, y] from the top-left corner, or null behind the camera or outside the viewport.
 */
export function projectToScreen(surfacePoint: Float32Array, labelView: LabelView): [number, number] | null {
  const matrixValues = labelView.modelViewProj;
  const [pointPosX, pointPosY, pointPosZ] = surfacePoint;
  const clipPosX = matrixValues[0] * pointPosX + matrixValues[4] * pointPosY + matrixValues[8] * pointPosZ + matrixValues[12];
  const clipPosY = matrixValues[1] * pointPosX + matrixValues[5] * pointPosY + matrixValues[9] * pointPosZ + matrixValues[13];
  const clipPosW = matrixValues[3] * pointPosX + matrixValues[7] * pointPosY + matrixValues[11] * pointPosZ + matrixValues[15];
  if (clipPosW <= 0) return null;
  const devicePosX = clipPosX / clipPosW;
  const devicePosY = clipPosY / clipPosW;
  if (devicePosX < -1 || devicePosX > 1 || devicePosY < -1 || devicePosY > 1) return null;
  return [((devicePosX + 1) / 2) * labelView.viewportWidth, ((1 - devicePosY) / 2) * labelView.viewportHeight];
}

/**
 * Estimated screen box of a label centred on a point.
 *
 * Usage: overlap test (avoids measuring DOM text every frame).
 *
 * @param labelText - Label text.
 * @param centerPosX - Centre x in CSS pixels.
 * @param centerPosY - Centre y in CSS pixels.
 * @returns The rectangle.
 */
function labelRect(labelText: string, centerPosX: number, centerPosY: number): ScreenRect {
  const halfWidth = (labelText.length * CHAR_WIDTH_PX + LABEL_PADDING_PX) / 2;
  const halfHeight = LABEL_HEIGHT_PX / 2;
  return {
    leftEdge: centerPosX - halfWidth,
    topEdge: centerPosY - halfHeight,
    rightEdge: centerPosX + halfWidth,
    bottomEdge: centerPosY + halfHeight,
  };
}

/**
 * Whether two rectangles overlap.
 *
 * Usage: overlap test.
 *
 * @param firstRect - First rectangle.
 * @param secondRect - Second rectangle.
 * @returns True when they intersect.
 */
function rectsOverlap(firstRect: ScreenRect, secondRect: ScreenRect): boolean {
  return (
    firstRect.leftEdge < secondRect.rightEdge &&
    secondRect.leftEdge < firstRect.rightEdge &&
    firstRect.topEdge < secondRect.bottomEdge &&
    secondRect.topEdge < firstRect.bottomEdge
  );
}

/**
 * Choose which labels to show and where.
 *
 * Usage: every frame while plate names are shown. Requests are taken in order (pass
 * the most important first); a label is dropped when it is on the far side of the
 * globe, off screen, or would overlap one already placed, so zooming in reveals more.
 *
 * @param labelRequests - Labels in priority order.
 * @param labelView - Camera and viewport.
 * @returns At most 60 placed labels.
 */
export function placeLabels(labelRequests: LabelRequest[], labelView: LabelView): PlacedLabel[] {
  const placedLabels: PlacedLabel[] = [];
  const takenRects: ScreenRect[] = [];
  const surfacePoint = new Float32Array(3);
  for (const labelRequest of labelRequests) {
    if (placedLabels.length >= MAX_PLACED_LABELS) break;
    writeSurfacePoint(labelRequest.labelUnit, surfacePoint, 0);
    if (!facesCamera(surfacePoint, labelRequest.labelUnit, labelView.eyePosition)) continue;
    const screenPoint = projectToScreen(surfacePoint, labelView);
    if (!screenPoint) continue;
    const candidateRect = labelRect(labelRequest.labelText, screenPoint[0], screenPoint[1]);
    if (takenRects.some((takenRect) => rectsOverlap(takenRect, candidateRect))) continue;
    takenRects.push(candidateRect);
    placedLabels.push({
      labelText: labelRequest.labelText,
      labelStyle: labelRequest.labelStyle ?? "plate",
      screenX: screenPoint[0],
      screenY: screenPoint[1],
    });
  }
  return placedLabels;
}
