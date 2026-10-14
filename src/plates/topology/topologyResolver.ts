/**
 * Resolve the topological plate polygons of the plate model at an age: reconstruct
 * every section, clip sections against their neighbours and join them into plate
 * rings. The clipped sections are also the plate boundaries (ridges, subduction
 * zones, transforms, ...), returned once each in their feature's own direction so
 * that subduction polarity (left/right) keeps its meaning, together with the plates
 * found on either side.
 */

import type { RotationTree } from "../rotationTree";
import type { UnitVector } from "../sphericalCoords";
import type { BoundarySegment } from "./boundaryMerging";
import { ResolutionPass } from "./resolutionPass";
import { clipSections } from "./sectionClipping";
import { ringInteriorOnLeft } from "./sphericalRing";
import type { PlateTopology, SectionLink, TopologyModel, TopologyWindow } from "./topologyModel";

/** A plate polygon at the resolved age. */
export type ResolvedPlate = {
  plateNumber: number;
  /** Raw topology name (see plateDisplayName for display names). */
  topologyName: string;
  topologyIndex: number;
  /** Ring vertices (implicitly closed). */
  ringUnits: UnitVector[];
};

export type ResolvedTopologies = { ageInMyr: number; resolvedPlates: ResolvedPlate[]; boundarySegments: BoundarySegment[] };

/**
 * Whether an age lies inside [end, begin].
 *
 * Usage: active topologies and windows.
 *
 * @param ageInMyr - Age in Ma.
 * @param beginAgeMa - Older bound.
 * @param endAgeMa - Younger bound.
 * @returns True when inside (inclusive).
 */
function ageWithin(ageInMyr: number, beginAgeMa: number, endAgeMa: number): boolean {
  return ageInMyr <= beginAgeMa && ageInMyr >= endAgeMa;
}

export class TopologyResolver {
  /**
   * Bind the resolver to a model.
   *
   * Usage: once after loading /api/plates/topologies.
   *
   * @param topologyModel - Prepared model.
   */
  constructor(private readonly topologyModel: TopologyModel) {}

  /**
   * Section window of a topology at an age.
   *
   * Usage: topologies whose section list changes through time.
   *
   * @param plateTopology - Topology.
   * @param ageInMyr - Age in Ma.
   * @returns The first window containing the age, or null.
   */
  private windowAt(plateTopology: PlateTopology, ageInMyr: number): TopologyWindow | null {
    if (!ageWithin(ageInMyr, plateTopology.beginAgeMa, plateTopology.endAgeMa)) return null;
    return plateTopology.windows.find((topologyWindow) => ageWithin(ageInMyr, topologyWindow.beginAgeMa, topologyWindow.endAgeMa)) ?? null;
  }

  /**
   * Resolve one plate polygon and record its boundary pieces.
   *
   * Usage: per active topology.
   *
   * @param resolutionPass - Current pass.
   * @param sectionLinks - Sections of the active window.
   * @param plateNumber - Plate of the topology.
   * @returns The ring, or null with fewer than 3 vertices.
   */
  private resolveRing(resolutionPass: ResolutionPass, sectionLinks: SectionLink[], plateNumber: number): UnitVector[] | null {
    const orientedSections = resolutionPass.orientSections(sectionLinks);
    const clippedSections = clipSections(orientedSections.map((orientedSection) => orientedSection.orientedUnits), true);
    const ringUnits = clippedSections.flatMap((clippedSection) => clippedSection.clippedUnits);
    if (ringUnits.length < 3) return null;
    resolutionPass.collectBoundaries(orientedSections, clippedSections, { plateNumber, interiorOnLeft: ringInteriorOnLeft(ringUnits) });
    return ringUnits;
  }

  /**
   * Resolve all plates and boundaries at an age.
   *
   * Usage: whenever the displayed age changes while a topology layer is shown.
   *
   * @param rotationTree - Rotation model.
   * @param ageInMyr - Age in Ma.
   * @returns Plate polygons and unique boundary segments.
   */
  resolveAt(rotationTree: RotationTree, ageInMyr: number): ResolvedTopologies {
    const resolutionPass = new ResolutionPass(this.topologyModel, rotationTree, ageInMyr);
    const resolvedPlates: ResolvedPlate[] = [];
    this.topologyModel.plateTopologies.forEach((plateTopology, topologyIndex) => {
      const activeWindow = this.windowAt(plateTopology, ageInMyr);
      if (!activeWindow) return;
      const ringUnits = this.resolveRing(resolutionPass, activeWindow.sectionLinks, plateTopology.plateNumber);
      if (!ringUnits) return;
      resolvedPlates.push({ plateNumber: plateTopology.plateNumber, topologyName: plateTopology.plateName, topologyIndex, ringUnits });
    });
    return { ageInMyr, resolvedPlates, boundarySegments: resolutionPass.boundarySegments() };
  }
}
