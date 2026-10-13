/** Lon/lat bounding boxes, including boxes that wrap the antimeridian (westEdge > eastEdge). */

/** Box in degrees; westEdge > eastEdge means it crosses the antimeridian. */
export type BoundingBox = { westEdge: number; southEdge: number; eastEdge: number; northEdge: number };

/**
 * Longitudinal width of a box.
 *
 * Usage: insetting and size checks.
 *
 * @param boundingBox - Box, possibly wrapping.
 * @returns Width in degrees (0..360).
 */
export function lonSpanOf(boundingBox: BoundingBox): number {
  return boundingBox.westEdge <= boundingBox.eastEdge
    ? boundingBox.eastEdge - boundingBox.westEdge
    : 360 - (boundingBox.westEdge - boundingBox.eastEdge);
}

/**
 * Test whether a point lies in a box (edges inclusive).
 *
 * Usage: containment tests of box corners.
 *
 * @param longitudeDeg - Point longitude.
 * @param latitudeDeg - Point latitude.
 * @param boundingBox - Box, possibly wrapping.
 * @returns True when inside.
 */
export function pointInBounds(longitudeDeg: number, latitudeDeg: number, boundingBox: BoundingBox): boolean {
  if (latitudeDeg < boundingBox.southEdge || latitudeDeg > boundingBox.northEdge) return false;
  if (boundingBox.westEdge <= boundingBox.eastEdge) {
    return longitudeDeg >= boundingBox.westEdge && longitudeDeg <= boundingBox.eastEdge;
  }
  return longitudeDeg >= boundingBox.westEdge || longitudeDeg <= boundingBox.eastEdge;
}

/**
 * Shrink a box by a fraction of its size on every side.
 *
 * Usage: containment with a safety margin.
 *
 * @param boundingBox - Box, possibly wrapping.
 * @param insetFraction - Fraction of the width/height removed per side.
 * @returns The inset box.
 */
export function insetBounds(boundingBox: BoundingBox, insetFraction: number): BoundingBox {
  const latitudePad = (boundingBox.northEdge - boundingBox.southEdge) * insetFraction;
  const southEdge = boundingBox.southEdge + latitudePad;
  const northEdge = boundingBox.northEdge - latitudePad;
  const longitudePad = lonSpanOf(boundingBox) * insetFraction;
  if (boundingBox.westEdge <= boundingBox.eastEdge) {
    return {
      westEdge: boundingBox.westEdge + longitudePad,
      southEdge,
      eastEdge: boundingBox.eastEdge - longitudePad,
      northEdge,
    };
  }
  let westEdge = boundingBox.westEdge + longitudePad;
  let eastEdge = boundingBox.eastEdge - longitudePad;
  if (westEdge > 180) westEdge -= 360;
  if (eastEdge < -180) eastEdge += 360;
  return { westEdge, southEdge, eastEdge, northEdge };
}

/**
 * Test whether one box contains another.
 *
 * Usage: decide whether loaded detail still covers the visible ground.
 *
 * @param outerBox - Containing box.
 * @param innerBox - Contained box.
 * @param marginFraction - Optional inset of the outer box (0 = none).
 * @returns True when innerBox lies within the (inset) outerBox.
 */
export function boundsContain(outerBox: BoundingBox, innerBox: BoundingBox, marginFraction = 0): boolean {
  const effectiveBox = marginFraction > 0 ? insetBounds(outerBox, marginFraction) : outerBox;
  if (effectiveBox.southEdge >= effectiveBox.northEdge) return false;
  const testLongitudes: number[] = [];
  if (innerBox.westEdge <= innerBox.eastEdge) {
    testLongitudes.push(innerBox.westEdge, innerBox.eastEdge);
  } else {
    testLongitudes.push(innerBox.westEdge, 180, -180, innerBox.eastEdge);
  }
  for (const longitudeDeg of testLongitudes) {
    if (
      !pointInBounds(longitudeDeg, innerBox.southEdge, effectiveBox) ||
      !pointInBounds(longitudeDeg, innerBox.northEdge, effectiveBox)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Split a wrapping box into non-wrapping parts.
 *
 * Usage: rectangle clipping, which needs westEdge <= eastEdge.
 *
 * @param boundingBox - Box, possibly wrapping.
 * @returns One box, or the west-of-180 and east-of-−180 halves.
 */
export function splitAtAntimeridian(boundingBox: BoundingBox): BoundingBox[] {
  if (boundingBox.westEdge <= boundingBox.eastEdge) {
    return [
      {
        westEdge: boundingBox.westEdge,
        southEdge: boundingBox.southEdge,
        eastEdge: boundingBox.eastEdge,
        northEdge: boundingBox.northEdge,
      },
    ];
  }
  return [
    { westEdge: boundingBox.westEdge, southEdge: boundingBox.southEdge, eastEdge: 180, northEdge: boundingBox.northEdge },
    { westEdge: -180, southEdge: boundingBox.southEdge, eastEdge: boundingBox.eastEdge, northEdge: boundingBox.northEdge },
  ];
}

/**
 * Grow a box by a fixed margin, clamped to ±85° latitude.
 *
 * Usage: detail meshes overlap the base mesh's hidden area slightly.
 *
 * @param boundingBox - Box, possibly wrapping.
 * @param paddingDeg - Margin in degrees.
 * @returns The padded box (whole longitude range when it would cover ≥ 359°).
 */
export function padBounds(boundingBox: BoundingBox, paddingDeg: number): BoundingBox {
  const southEdge = Math.max(-85, boundingBox.southEdge - paddingDeg);
  const northEdge = Math.min(85, boundingBox.northEdge + paddingDeg);
  if (
    boundingBox.westEdge <= boundingBox.eastEdge &&
    boundingBox.eastEdge - boundingBox.westEdge + 2 * paddingDeg >= 359
  ) {
    return { westEdge: -180, southEdge, eastEdge: 180, northEdge };
  }
  let westEdge = boundingBox.westEdge - paddingDeg;
  let eastEdge = boundingBox.eastEdge + paddingDeg;
  if (westEdge < -180) westEdge += 360;
  if (eastEdge > 180) eastEdge -= 360;
  return { westEdge, southEdge, eastEdge, northEdge };
}

/**
 * Test whether a box covers the whole data range.
 *
 * Usage: skip clipping for world requests.
 *
 * @param boundingBox - Box to test.
 * @returns True for (almost) −180..180 × −84..84 or larger.
 */
export function isWorldBounds(boundingBox: BoundingBox): boolean {
  return (
    boundingBox.westEdge <= -179 &&
    boundingBox.eastEdge >= 179 &&
    boundingBox.southEdge <= -84 &&
    boundingBox.northEdge >= 84
  );
}
