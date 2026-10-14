/**
 * Field-line shape of a bar magnet inside the Earth.
 *
 * The magnet is modelled by a north and a south magnetic charge on the magnetic axis,
 * MAGNET_HALF_LENGTH Earth radii above and below the centre (just under each magnetic
 * pole). Unlike a point dipole at the centre, its lines leave the ground in a narrow
 * tube around the north magnetic pole and enter it around the south pole, like the field
 * of a bar magnet. The field is axially symmetric, so one profile in a meridian plane
 * (axial offset, height along the axis) serves every azimuth.
 */

/** Distance of each magnetic charge from the Earth's centre, in Earth radii (< 1). */
export const MAGNET_HALF_LENGTH = 0.85;
const TRACE_STEP = 0.004;
const MAX_TRACE_STEPS = 20_000;
const SEARCH_ITERATIONS = 30;
const MIN_FOOT_COLATITUDE_RAD = (0.5 * Math.PI) / 180;
const MAX_FOOT_COLATITUDE_RAD = (60 * Math.PI) / 180;

/** A point of the meridian plane: [axial offset, height along the axis], in Earth radii. */
export type ProfilePoint = [number, number];

/** One traced line: where it leaves the ground and its points from the north to the south foot. */
export type FieldProfile = { footColatitudeRad: number; apexRadius: number; profilePoints: ProfilePoint[] };

const profileCache = new Map<string, FieldProfile>();

/**
 * Unit field direction of the magnet at a meridian-plane point.
 *
 * Usage: field-line tracing.
 *
 * @param axialOffset - Distance from the axis (≥ 0).
 * @param axialHeight - Height along the axis (north positive).
 * @returns Unit direction [offset, height], pointing away from the north charge.
 */
function fieldDirection(axialOffset: number, axialHeight: number): ProfilePoint {
  const northGap = axialHeight - MAGNET_HALF_LENGTH;
  const southGap = axialHeight + MAGNET_HALF_LENGTH;
  const northCube = Math.hypot(axialOffset, northGap) ** 3;
  const southCube = Math.hypot(axialOffset, southGap) ** 3;
  const offsetField = axialOffset / northCube - axialOffset / southCube;
  const heightField = northGap / northCube - southGap / southCube;
  const fieldLength = Math.hypot(offsetField, heightField) || 1;
  return [offsetField / fieldLength, heightField / fieldLength];
}

/**
 * One Runge–Kutta (4th order) step along the field direction.
 *
 * Usage: traceFromColatitude.
 *
 * @param startPoint - Current point.
 * @returns The next point, TRACE_STEP further along the line.
 */
function rungeKuttaStep(startPoint: ProfilePoint): ProfilePoint {
  const [startOffset, startHeight] = startPoint;
  const firstSlope = fieldDirection(startOffset, startHeight);
  const secondSlope = fieldDirection(startOffset + (TRACE_STEP / 2) * firstSlope[0], startHeight + (TRACE_STEP / 2) * firstSlope[1]);
  const thirdSlope = fieldDirection(startOffset + (TRACE_STEP / 2) * secondSlope[0], startHeight + (TRACE_STEP / 2) * secondSlope[1]);
  const fourthSlope = fieldDirection(startOffset + TRACE_STEP * thirdSlope[0], startHeight + TRACE_STEP * thirdSlope[1]);
  return [0, 1].map(
    (componentIdx) =>
      startPoint[componentIdx] +
      (TRACE_STEP / 6) * (firstSlope[componentIdx] + 2 * secondSlope[componentIdx] + 2 * thirdSlope[componentIdx] + fourthSlope[componentIdx])
  ) as ProfilePoint;
}

/**
 * Trace a line from the ground at a colatitude until it returns to the ground.
 *
 * Usage: profile search.
 *
 * @param footColatitudeRad - Angle of the start point from the north magnetic pole.
 * @returns Points from the north foot to the south foot (the last one moved onto the ground).
 */
export function traceFromColatitude(footColatitudeRad: number): ProfilePoint[] {
  const tracedPoints: ProfilePoint[] = [[Math.sin(footColatitudeRad), Math.cos(footColatitudeRad)]];
  let currentPoint = tracedPoints[0];
  for (let stepIndex = 0; stepIndex < MAX_TRACE_STEPS; stepIndex++) {
    currentPoint = rungeKuttaStep(currentPoint);
    const pointRadius = Math.hypot(currentPoint[0], currentPoint[1]);
    if (pointRadius <= 1 && stepIndex > 0) {
      tracedPoints.push([currentPoint[0] / pointRadius, currentPoint[1] / pointRadius]);
      break;
    }
    tracedPoints.push(currentPoint);
  }
  return tracedPoints;
}

/**
 * Farthest distance of a traced line from the centre.
 *
 * Usage: profile search.
 *
 * @param tracedPoints - Line points.
 * @returns Apex distance in Earth radii.
 */
function apexRadiusOf(tracedPoints: ProfilePoint[]): number {
  return Math.max(...tracedPoints.map((tracedPoint) => Math.hypot(tracedPoint[0], tracedPoint[1])));
}

/**
 * Resample a polyline to evenly spaced points.
 *
 * Usage: give every drawn line the same vertex count.
 *
 * @param tracedPoints - Dense points (≥ 2).
 * @param sampleCount - Output segments (≥ 1).
 * @returns sampleCount + 1 points from the first to the last input point.
 */
export function resampleProfile(tracedPoints: ProfilePoint[], sampleCount: number): ProfilePoint[] {
  const cumulativeLengths = [0];
  for (let pointIdx = 1; pointIdx < tracedPoints.length; pointIdx++) {
    const [previousOffset, previousHeight] = tracedPoints[pointIdx - 1];
    cumulativeLengths.push(cumulativeLengths[pointIdx - 1] + Math.hypot(tracedPoints[pointIdx][0] - previousOffset, tracedPoints[pointIdx][1] - previousHeight));
  }
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];
  const sampledPoints: ProfilePoint[] = [];
  let segmentIdx = 1;
  for (let sampleIdx = 0; sampleIdx <= sampleCount; sampleIdx++) {
    const targetLength = (totalLength * sampleIdx) / sampleCount;
    while (segmentIdx < tracedPoints.length - 1 && cumulativeLengths[segmentIdx] < targetLength) segmentIdx++;
    const segmentLength = cumulativeLengths[segmentIdx] - cumulativeLengths[segmentIdx - 1] || 1;
    const segmentFraction = Math.min(1, Math.max(0, (targetLength - cumulativeLengths[segmentIdx - 1]) / segmentLength));
    const [startOffset, startHeight] = tracedPoints[segmentIdx - 1];
    const [endOffset, endHeight] = tracedPoints[segmentIdx];
    sampledPoints.push([startOffset + (endOffset - startOffset) * segmentFraction, startHeight + (endHeight - startHeight) * segmentFraction]);
  }
  return sampledPoints;
}

/**
 * The field line whose apex is at a given distance (cached).
 *
 * Usage: one per field-line layer. Lines leaving the ground closer to the pole reach
 * further out, so the foot colatitude is found by bisection.
 *
 * @param apexRadius - Wanted apex distance in Earth radii (> 1).
 * @param sampleCount - Segments of the returned profile.
 * @returns The profile (foot colatitude, actual apex and evenly spaced points).
 */
export function profileForApex(apexRadius: number, sampleCount: number): FieldProfile {
  const cacheKey = `${apexRadius}|${sampleCount}`;
  const cachedProfile = profileCache.get(cacheKey);
  if (cachedProfile) return cachedProfile;
  let nearPoleRad = MIN_FOOT_COLATITUDE_RAD;
  let farPoleRad = MAX_FOOT_COLATITUDE_RAD;
  for (let searchIdx = 0; searchIdx < SEARCH_ITERATIONS; searchIdx++) {
    const middleRad = (nearPoleRad + farPoleRad) / 2;
    if (apexRadiusOf(traceFromColatitude(middleRad)) > apexRadius) nearPoleRad = middleRad;
    else farPoleRad = middleRad;
  }
  const footColatitudeRad = (nearPoleRad + farPoleRad) / 2;
  const tracedPoints = traceFromColatitude(footColatitudeRad);
  const fieldProfile = { footColatitudeRad, apexRadius: apexRadiusOf(tracedPoints), profilePoints: resampleProfile(tracedPoints, sampleCount) };
  profileCache.set(cacheKey, fieldProfile);
  return fieldProfile;
}
