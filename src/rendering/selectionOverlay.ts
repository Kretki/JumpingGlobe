/** Selection overlay: track line, present-day dot and the marker at the displayed age. */

import { WGS84_SEMI_MAJOR, writeSurfacePoint } from "../geodesy/wgs84Ellipsoid";
import type { TrackSample } from "../plates/pointTrack";
import type { UnitVector } from "../plates/sphericalCoords";
import type { Matrix4x4 } from "./matrixMath";
import { createProgram } from "./shaderProgram";
import { OVERLAY_FRAGMENT_SHADER, OVERLAY_VERTEX_SHADER } from "./shaderSources";

/** [first vertex, vertex count] of one continuous piece of the track. */
type TrackSegment = [number, number];

const TRACK_COLOR: [number, number, number, number] = [1.0, 0.84, 0.25, 1.0];
const MARKER_COLOR: [number, number, number, number] = [1.0, 0.35, 0.31, 1];
const MAX_LIFT_M = 40_000;
const MIN_LIFT_M = 30;

export class SelectionOverlay {
  private readonly overlayProgram: WebGLProgram;
  private readonly positionAttribute: number;
  private readonly uniformLocations: Record<
    "modelViewProj" | "liftScale" | "pointSize" | "fillColor" | "roundDots",
    WebGLUniformLocation | null
  >;
  private readonly trackBuffer: WebGLBuffer;
  private readonly markerBuffer: WebGLBuffer;
  private trackSegments: TrackSegment[] = [];

  /**
   * Compile the overlay program and allocate its buffers.
   *
   * Usage: once at start-up.
   *
   * @param glContext - WebGL context.
   * @param globeProgram - Program restored after drawing.
   * @param globeNormalAttribute - Globe normal attribute, disabled while drawing.
   */
  constructor(
    private readonly glContext: WebGLRenderingContext,
    private readonly globeProgram: WebGLProgram,
    private readonly globeNormalAttribute: number
  ) {
    this.overlayProgram = createProgram(glContext, OVERLAY_VERTEX_SHADER, OVERLAY_FRAGMENT_SHADER);
    this.positionAttribute = glContext.getAttribLocation(this.overlayProgram, "aOverlayPos");
    const uniformOf = (uniformName: string) => glContext.getUniformLocation(this.overlayProgram, uniformName);
    this.uniformLocations = {
      modelViewProj: uniformOf("uModelViewProj"),
      liftScale: uniformOf("uLiftScale"),
      pointSize: uniformOf("uPointSize"),
      fillColor: uniformOf("uFillColor"),
      roundDots: uniformOf("uRoundDots"),
    };
    this.trackBuffer = glContext.createBuffer()!;
    this.markerBuffer = glContext.createBuffer()!;
  }

  /**
   * Upload a track; gaps (null samples) split it into segments.
   *
   * Usage: when a point is selected; an empty list clears the track.
   *
   * @param trackSamples - Samples of the selected point.
   * @returns Nothing.
   */
  uploadTrack(trackSamples: TrackSample[]): void {
    this.trackSegments = [];
    if (!trackSamples.length) return;
    const pointData = new Float32Array(trackSamples.length * 3);
    let pointCount = 0;
    let segmentStart = -1;
    for (const trackSample of trackSamples) {
      if (trackSample.unitVector) {
        if (segmentStart < 0) segmentStart = pointCount;
        writeSurfacePoint(trackSample.unitVector, pointData, pointCount * 3);
        pointCount++;
      } else if (segmentStart >= 0) {
        this.trackSegments.push([segmentStart, pointCount - segmentStart]);
        segmentStart = -1;
      }
    }
    if (segmentStart >= 0) this.trackSegments.push([segmentStart, pointCount - segmentStart]);
    this.glContext.bindBuffer(this.glContext.ARRAY_BUFFER, this.trackBuffer);
    this.glContext.bufferData(this.glContext.ARRAY_BUFFER, pointData.subarray(0, pointCount * 3), this.glContext.STATIC_DRAW);
  }

  /**
   * Draw the track line.
   *
   * Usage: first part of draw.
   *
   * @returns Nothing.
   */
  private drawTrack(): void {
    if (!this.trackSegments.length) return;
    const glContext = this.glContext;
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.trackBuffer);
    glContext.vertexAttribPointer(this.positionAttribute, 3, glContext.FLOAT, false, 0, 0);
    glContext.uniform4f(this.uniformLocations.fillColor, ...TRACK_COLOR);
    glContext.uniform1f(this.uniformLocations.roundDots, 1);
    glContext.uniform1f(this.uniformLocations.pointSize, 3);
    for (const [firstVertex, vertexCount] of this.trackSegments) {
      if (vertexCount > 1) glContext.drawArrays(glContext.LINE_STRIP, firstVertex, vertexCount);
      else glContext.drawArrays(glContext.POINTS, firstVertex, vertexCount);
    }
  }

  /**
   * Draw the present-day dot and the white-ringed red marker at the displayed age.
   *
   * Usage: second part of draw.
   *
   * @param presentUnit - Present-day position.
   * @param currentUnit - Position at the displayed age, or null when undefined.
   * @returns Nothing.
   */
  private drawMarkers(presentUnit: UnitVector, currentUnit: UnitVector | null): void {
    const glContext = this.glContext;
    const markerData = new Float32Array(6);
    writeSurfacePoint(presentUnit, markerData, 0);
    if (currentUnit) writeSurfacePoint(currentUnit, markerData, 3);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.markerBuffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, markerData, glContext.DYNAMIC_DRAW);
    glContext.vertexAttribPointer(this.positionAttribute, 3, glContext.FLOAT, false, 0, 0);
    glContext.uniform1f(this.uniformLocations.roundDots, 1);
    glContext.uniform4f(this.uniformLocations.fillColor, 1, 1, 1, 1);
    glContext.uniform1f(this.uniformLocations.pointSize, 7);
    glContext.drawArrays(glContext.POINTS, 0, 1);
    if (!currentUnit) return;
    glContext.uniform1f(this.uniformLocations.pointSize, 15);
    glContext.drawArrays(glContext.POINTS, 1, 1);
    glContext.uniform4f(this.uniformLocations.fillColor, ...MARKER_COLOR);
    glContext.uniform1f(this.uniformLocations.pointSize, 10);
    glContext.drawArrays(glContext.POINTS, 1, 1);
  }

  /**
   * Draw the selection on top of the globe.
   *
   * Usage: after GlobeRenderer.drawFrame while a point is selected.
   *
   * @param modelViewProj - Camera matrix.
   * @param cameraHeightM - Camera height (sets the lift above the land).
   * @param presentUnit - Present-day position of the point.
   * @param currentUnit - Its position at the displayed age, or null.
   * @returns Nothing; restores the globe program.
   */
  drawSelection(modelViewProj: Matrix4x4, cameraHeightM: number, presentUnit: UnitVector, currentUnit: UnitVector | null): void {
    const glContext = this.glContext;
    glContext.useProgram(this.overlayProgram);
    // Marker ring + fill share a depth: LEQUAL lets the fill draw over the ring.
    glContext.depthFunc(glContext.LEQUAL);
    glContext.disableVertexAttribArray(this.globeNormalAttribute);
    glContext.uniformMatrix4fv(this.uniformLocations.modelViewProj, false, modelViewProj);
    // Lift above the land (which floats up to ~600 m on coarse LODs) proportionally
    // to the view distance, so it stays on top without visible parallax.
    const liftMeters = Math.min(MAX_LIFT_M, Math.max(MIN_LIFT_M, cameraHeightM * 0.004));
    glContext.uniform1f(this.uniformLocations.liftScale, liftMeters / WGS84_SEMI_MAJOR);
    glContext.enableVertexAttribArray(this.positionAttribute);
    this.drawTrack();
    this.drawMarkers(presentUnit, currentUnit);
    glContext.disableVertexAttribArray(this.positionAttribute);
    glContext.depthFunc(glContext.LESS);
    glContext.useProgram(this.globeProgram);
  }
}
