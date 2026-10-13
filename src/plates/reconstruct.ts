/** Move plate-tagged land meshes to their position at a given age (CPU, per vertex). */

import { WGS84_ECC_SQUARED, WGS84_SEMI_MAJOR } from "../geodesy/wgs84Ellipsoid";
import type { LandMesh, PlateGroup } from "../land/meshTypes";
import { IDENTITY_QUAT, quatRotate, type Quaternion } from "./quaternionMath";
import type { RotationTree } from "./rotationTree";

const BOWRING_ITERATIONS = 3;

/**
 * Present-day mesh in rotation-friendly form. GPlates rotates lon/lat as points
 * on a sphere, so each vertex keeps the unit vector of its geodetic lon/lat plus
 * its height above the ellipsoid; positions are rebuilt on the ellipsoid after
 * rotating, so land never floats above or sinks below the surface when it moves
 * to another latitude.
 */
export type PlateMesh = {
  unitVectors: Float32Array;
  heightsMeters: Float32Array;
  groupIdx: Uint16Array;
  plateGroups: PlateGroup[];
  triangleIndices: Uint32Array;
  positions: Float32Array;
  vertexNormals: Float32Array;
  /** Any group carries a real plate id (false for untagged LOD files). */
  isTagged: boolean;
};

export type ReconstructStats = { groupCount: number; shownCount: number; noRotation: number; notYetFormed: number };

/**
 * Convert a land mesh into rotation-friendly form.
 *
 * Usage: once per loaded mesh, before reconstruct.
 *
 * @param landMesh - Present-day mesh.
 * @returns PlateMesh with its own copies of positions and normals (rewritten per age).
 */
export function preparePlateMesh(landMesh: LandMesh): PlateMesh {
  const vertexCount = landMesh.positions.length / 3;
  const unitVectors = new Float32Array(vertexCount * 3);
  const heightsMeters = new Float32Array(vertexCount);
  const positionData = landMesh.positions;
  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    const ecefPointX = positionData[vertexIdx * 3];
    const ecefPointY = positionData[vertexIdx * 3 + 1];
    const ecefPointZ = positionData[vertexIdx * 3 + 2];
    const planarDist = Math.hypot(ecefPointX, ecefPointY);
    // Bowring-style fixed point; land sits within metres of the ellipsoid.
    let latitudeRad = Math.atan2(ecefPointZ, planarDist * (1 - WGS84_ECC_SQUARED));
    for (let iteration = 0; iteration < BOWRING_ITERATIONS; iteration++) {
      const sinIterate = Math.sin(latitudeRad);
      const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * sinIterate * sinIterate);
      latitudeRad = Math.atan2(ecefPointZ + WGS84_ECC_SQUARED * primeVertical * sinIterate, planarDist);
    }
    const sinLatitude = Math.sin(latitudeRad);
    const cosLatitude = Math.cos(latitudeRad);
    const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * sinLatitude * sinLatitude);
    heightsMeters[vertexIdx] =
      Math.abs(cosLatitude) > 1e-9
        ? planarDist / cosLatitude - primeVertical
        : Math.abs(ecefPointZ) - primeVertical * (1 - WGS84_ECC_SQUARED);
    const longitudeRad = Math.atan2(ecefPointY, ecefPointX);
    unitVectors[vertexIdx * 3] = cosLatitude * Math.cos(longitudeRad);
    unitVectors[vertexIdx * 3 + 1] = cosLatitude * Math.sin(longitudeRad);
    unitVectors[vertexIdx * 3 + 2] = sinLatitude;
  }
  return {
    unitVectors,
    heightsMeters,
    groupIdx: landMesh.groupIdx,
    plateGroups: landMesh.plateGroups,
    triangleIndices: landMesh.triangleIndices,
    positions: new Float32Array(landMesh.positions),
    vertexNormals: new Float32Array(landMesh.vertexNormals),
    isTagged: landMesh.plateGroups.some((plateGroup) => plateGroup.plateNumber !== 0),
  };
}

/**
 * Rotation of every plate group at an age (null = hidden).
 *
 * Usage: first step of reconstruct.
 *
 * @param plateGroups - Groups of the mesh.
 * @param rotationTree - Rotation model, or null (identity).
 * @param ageInMyr - Age in Ma.
 * @param reconstructStats - Statistics to update.
 * @returns One quaternion (or null) per group.
 */
function groupRotations(
  plateGroups: PlateGroup[],
  rotationTree: RotationTree | null,
  ageInMyr: number,
  reconstructStats: ReconstructStats
): (Quaternion | null)[] {
  return plateGroups.map((plateGroup) => {
    if (ageInMyr > plateGroup.appearAgeMa || ageInMyr < plateGroup.vanishAgeMa) {
      reconstructStats.notYetFormed++;
      return null;
    }
    const groupQuat =
      !rotationTree || ageInMyr <= 0 || plateGroup.plateNumber === 0
        ? IDENTITY_QUAT
        : rotationTree.totalRotation(plateGroup.plateNumber, ageInMyr);
    if (!groupQuat) reconstructStats.noRotation++;
    else reconstructStats.shownCount++;
    return groupQuat;
  });
}

/**
 * Rewrite a plate mesh's positions and normals for an age.
 *
 * Usage: whenever the timeline age changes. Groups outside their lifetime, or whose
 * plate chain has no poles at that age, collapse to the origin (zero-area
 * triangles, i.e. not drawn).
 *
 * @param plateMesh - Mesh to update in place.
 * @param rotationTree - Rotation model, or null (identity).
 * @param ageInMyr - Age in Ma.
 * @returns Counts of shown and hidden groups.
 */
export function reconstruct(plateMesh: PlateMesh, rotationTree: RotationTree | null, ageInMyr: number): ReconstructStats {
  const reconstructStats: ReconstructStats = {
    groupCount: plateMesh.plateGroups.length,
    shownCount: 0,
    noRotation: 0,
    notYetFormed: 0,
  };
  const rotationList = groupRotations(plateMesh.plateGroups, rotationTree, ageInMyr, reconstructStats);
  const { unitVectors, heightsMeters, groupIdx, positions, vertexNormals } = plateMesh;
  const rotatedUnit = [0, 0, 0];
  const vertexCount = heightsMeters.length;
  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    const vertexQuat = rotationList[groupIdx[vertexIdx]];
    const baseOffset = vertexIdx * 3;
    if (!vertexQuat) {
      positions[baseOffset] = positions[baseOffset + 1] = positions[baseOffset + 2] = 0;
      continue;
    }
    quatRotate(vertexQuat, unitVectors[baseOffset], unitVectors[baseOffset + 1], unitVectors[baseOffset + 2], rotatedUnit);
    const sinLatitude = rotatedUnit[2];
    const primeVertical = WGS84_SEMI_MAJOR / Math.sqrt(1 - WGS84_ECC_SQUARED * sinLatitude * sinLatitude);
    const heightMeters = heightsMeters[vertexIdx];
    positions[baseOffset] = (primeVertical + heightMeters) * rotatedUnit[0];
    positions[baseOffset + 1] = (primeVertical + heightMeters) * rotatedUnit[1];
    positions[baseOffset + 2] = (primeVertical * (1 - WGS84_ECC_SQUARED) + heightMeters) * rotatedUnit[2];
    // The ellipsoid normal at geodetic (lon, lat) is exactly the rotated unit vector.
    vertexNormals[baseOffset] = rotatedUnit[0];
    vertexNormals[baseOffset + 1] = rotatedUnit[1];
    vertexNormals[baseOffset + 2] = rotatedUnit[2];
  }
  return reconstructStats;
}
