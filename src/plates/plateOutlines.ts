/**
 * Plate outlines (static polygons dissolved per plate and lifetime, see
 * public/external/cao_prep.sh) in present-day coordinates, prepared for per-age
 * reconstruction: wireframe segments as unit vectors plus a label anchor.
 */

import { appendRingSegments, ringCentroid, type RingCentroid } from "./outlineGeometry";
import type { UnitVector } from "./sphericalCoords";
import type { StaticFeatureCollection } from "./staticPolygons";

const DISTANT_PAST_MA = 1e6;

export type PlateOutline = {
  plateNumber: number;
  /** Display name (plate model name, or "Plate <id>" when the model has none). */
  plateName: string;
  appearAgeMa: number;
  vanishAgeMa: number;
  /** GL_LINES vertex pairs, xyz unit vectors (present day). */
  segmentUnits: Float32Array;
  /** Label anchor: centroid of the largest polygon (present day). */
  labelUnit: UnitVector;
  /** Size of the outline (≈ steradians); larger plates win label space. */
  sizeWeight: number;
};

/**
 * Largest-polygon centroid and total size of a set of polygons.
 *
 * Usage: label anchor of one outline feature.
 *
 * @param polygonRings - Polygons, each [exterior, ...holes] of [lon°, lat°].
 * @returns Anchor of the largest exterior with the summed size, or null if all are degenerate.
 */
function outlineAnchor(polygonRings: number[][][][]): RingCentroid | null {
  let largestPart: RingCentroid | null = null;
  let totalWeight = 0;
  for (const polygonCoords of polygonRings) {
    const partCentroid = polygonCoords[0] ? ringCentroid(polygonCoords[0]) : null;
    if (!partCentroid) continue;
    totalWeight += partCentroid.sizeWeight;
    if (!largestPart || partCentroid.sizeWeight > largestPart.sizeWeight) largestPart = partCentroid;
  }
  return largestPart ? { centroidUnit: largestPart.centroidUnit, sizeWeight: totalWeight } : null;
}

/**
 * Wireframe segments of every ring of a set of polygons.
 *
 * Usage: outline geometry of one feature.
 *
 * @param polygonRings - Polygons, each [exterior, ...holes] of [lon°, lat°].
 * @returns GL_LINES vertex pairs as xyz unit vectors.
 */
function outlineSegments(polygonRings: number[][][][]): Float32Array {
  const segmentValues: number[] = [];
  for (const polygonCoords of polygonRings) {
    for (const ringCoords of polygonCoords) appendRingSegments(ringCoords, segmentValues);
  }
  return new Float32Array(segmentValues);
}

/**
 * Display name of an outline.
 *
 * Usage: label text.
 *
 * @param nameValue - ``name`` property from the layer (may be missing).
 * @param plateNumber - Plate id.
 * @returns The trimmed name, or "Plate <id>".
 */
function displayName(nameValue: unknown, plateNumber: number): string {
  const trimmedName = typeof nameValue === "string" ? nameValue.trim() : "";
  return trimmedName || `Plate ${plateNumber}`;
}

/**
 * Prepare the /api/land FeatureCollection of the plate-outline file.
 *
 * Usage: once, after fetching the outline layer.
 *
 * @param featureCollection - Body with ``plate_id``, ``name``, ``from_age``, ``to_age`` properties.
 * @returns Outlines sorted by size, largest first; features without a numeric plate id,
 *   polygon geometry or drawable edges are skipped.
 */
export function parsePlateOutlines(featureCollection: StaticFeatureCollection): PlateOutline[] {
  const outlineList: PlateOutline[] = [];
  for (const outlineFeature of featureCollection.features) {
    const geometry = outlineFeature.geometry;
    const featureProps = outlineFeature.properties ?? {};
    if (!geometry || typeof featureProps.plate_id !== "number") continue;
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") continue;
    const polygonRings = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
    const segmentUnits = outlineSegments(polygonRings);
    const labelAnchor = outlineAnchor(polygonRings);
    if (!segmentUnits.length || !labelAnchor) continue;
    outlineList.push({
      plateNumber: featureProps.plate_id,
      plateName: displayName(featureProps.name, featureProps.plate_id),
      appearAgeMa: typeof featureProps.from_age === "number" ? featureProps.from_age : DISTANT_PAST_MA,
      vanishAgeMa: typeof featureProps.to_age === "number" ? featureProps.to_age : 0,
      segmentUnits,
      labelUnit: labelAnchor.centroidUnit,
      sizeWeight: labelAnchor.sizeWeight,
    });
  }
  return outlineList.sort((firstOutline, secondOutline) => secondOutline.sizeWeight - firstOutline.sizeWeight);
}
