/**
 * One resolution of the topology model at one age: reconstructs (and caches) section
 * geometry, resolves topological lines, and collects the boundary pieces of every
 * resolved plate with the side the plate lies on.
 */

import type { RotationTree } from "../rotationTree";
import type { UnitVector } from "../sphericalCoords";
import { isFeatureActive, reconstructFeature } from "./featureReconstruction";
import { mergeBoundaryPieces, type BoundaryPiece, type BoundarySegment, type SectionSource } from "./boundaryMerging";
import { RotationCache } from "./rotationCache";
import { clipSections, type ClippedSection } from "./sectionClipping";
import type { SectionFeature, SectionLink, TopologyModel } from "./topologyModel";

/** A section of one topology at the resolved age, in traversal order. */
export type OrientedSection = { featureIndex: number; isReversed: boolean; orientedUnits: UnitVector[] };

/** Which plate a set of clipped sections belongs to and on which side of the traversal it lies. */
export type SectionOwner = { plateNumber: number; interiorOnLeft: boolean };

const MAX_TOPOLINE_DEPTH = 4;

export class ResolutionPass implements SectionSource {
  private readonly rotationCache: RotationCache;
  private readonly geometryCache = new Map<number, UnitVector[] | null>();
  private readonly boundaryPieces: BoundaryPiece[] = [];

  /**
   * Start a pass.
   *
   * Usage: TopologyResolver.resolve, once per age.
   *
   * @param topologyModel - Model.
   * @param rotationTree - Rotation model.
   * @param ageInMyr - Age in Ma.
   */
  constructor(
    private readonly topologyModel: TopologyModel,
    rotationTree: RotationTree,
    private readonly ageInMyr: number
  ) {
    this.rotationCache = new RotationCache(rotationTree);
  }

  /**
   * Geometry of a feature at the pass age (cached).
   *
   * Usage: every section lookup.
   *
   * @param featureIndex - Feature index.
   * @param topolineDepth - Nesting depth of topological lines (recursion guard).
   * @returns Reconstructed points, or null when inactive or unresolvable.
   */
  featureGeometry(featureIndex: number, topolineDepth = 0): UnitVector[] | null {
    const cachedGeometry = this.geometryCache.get(featureIndex);
    if (cachedGeometry !== undefined) return cachedGeometry;
    const sectionFeature = this.topologyModel.sectionFeatures[featureIndex];
    const featureGeometry =
      sectionFeature.featureKind === "topoline"
        ? this.topolineGeometry(sectionFeature, topolineDepth)
        : reconstructFeature(this.rotationCache, sectionFeature, this.ageInMyr);
    this.geometryCache.set(featureIndex, featureGeometry);
    return featureGeometry;
  }

  /**
   * Resolve a topological line (chain of point and line sections).
   *
   * Usage: featureGeometry for topoline features.
   *
   * @param sectionFeature - Topoline feature.
   * @param topolineDepth - Current nesting depth.
   * @returns The joined polyline, or null when inactive or with fewer than 2 points.
   */
  private topolineGeometry(sectionFeature: SectionFeature, topolineDepth: number): UnitVector[] | null {
    if (topolineDepth >= MAX_TOPOLINE_DEPTH || !isFeatureActive(sectionFeature, this.ageInMyr)) return null;
    const orientedSections = this.orientSections(sectionFeature.sectionLinks, topolineDepth + 1);
    const clippedSections = clipSections(orientedSections.map((orientedSection) => orientedSection.orientedUnits), false);
    const joinedUnits = clippedSections.flatMap((clippedSection) => clippedSection.clippedUnits);
    return joinedUnits.length >= 2 ? joinedUnits : null;
  }

  /**
   * Reconstructed, oriented sections of a section list (inactive ones dropped).
   *
   * Usage: topology windows and topological lines.
   *
   * @param sectionLinks - Sections in traversal order.
   * @param topolineDepth - Nesting depth for topological-line sections.
   * @returns Oriented sections.
   */
  orientSections(sectionLinks: SectionLink[], topolineDepth = 0): OrientedSection[] {
    const orientedSections: OrientedSection[] = [];
    for (const [featureIndex, reverseFlag] of sectionLinks) {
      const featureGeometry = this.featureGeometry(featureIndex, topolineDepth);
      if (!featureGeometry) continue;
      const isReversed = reverseFlag === 1;
      orientedSections.push({ featureIndex, isReversed, orientedUnits: isReversed ? [...featureGeometry].reverse() : featureGeometry });
    }
    return orientedSections;
  }

  /**
   * Attributes of a feature.
   *
   * Usage: SectionSource for boundary merging.
   *
   * @param featureIndex - Feature index.
   * @returns The feature.
   */
  sectionFeature(featureIndex: number): SectionFeature {
    return this.topologyModel.sectionFeatures[featureIndex];
  }

  /**
   * Record the line pieces of a resolved plate polygon.
   *
   * Usage: after clipping a plate polygon; pieces are merged per feature at the end.
   *
   * @param orientedSections - Sections of the polygon.
   * @param clippedSections - Their clipped pieces (traversal direction).
   * @param sectionOwner - Plate of the polygon and its interior side.
   * @returns Nothing.
   */
  collectBoundaries(orientedSections: OrientedSection[], clippedSections: ClippedSection[], sectionOwner: SectionOwner): void {
    clippedSections.forEach((clippedSection, sectionIdx) => {
      if (clippedSection.clippedUnits.length < 2) return;
      const { featureIndex, isReversed, orientedUnits } = orientedSections[sectionIdx];
      // Params in the feature's own direction; reversing also flips the plate's side.
      const lastParam = orientedUnits.length - 1;
      this.boundaryPieces.push({
        featureIndex,
        startParam: isReversed ? lastParam - clippedSection.endParam : clippedSection.startParam,
        endParam: isReversed ? lastParam - clippedSection.startParam : clippedSection.endParam,
        plateNumber: sectionOwner.plateNumber,
        plateOnLeft: sectionOwner.interiorOnLeft !== isReversed,
      });
    });
  }

  /**
   * Boundary stretches of every plate resolved so far, merged per feature.
   *
   * Usage: end of the pass.
   *
   * @returns Drawable boundary stretches with the plates on either side.
   */
  boundarySegments(): BoundarySegment[] {
    return mergeBoundaryPieces(this.boundaryPieces, this);
  }
}
