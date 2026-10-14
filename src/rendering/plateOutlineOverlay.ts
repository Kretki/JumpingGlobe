/** Plate-outline wireframe: GL_LINES lifted slightly above the land, hidden behind the globe by the depth test. */

import { WGS84_SEMI_MAJOR } from "../geodesy/wgs84Ellipsoid";
import type { Matrix4x4 } from "./matrixMath";
import { createProgram } from "./shaderProgram";
import { OVERLAY_FRAGMENT_SHADER, OVERLAY_VERTEX_SHADER } from "./shaderSources";

const OUTLINE_COLOR: [number, number, number, number] = [0.96, 0.96, 1.0, 1.0];
const MAX_LIFT_M = 30_000;
const MIN_LIFT_M = 20;
const LIFT_PER_HEIGHT = 0.003;

export class PlateOutlineOverlay {
  private readonly overlayProgram: WebGLProgram;
  private readonly positionAttribute: number;
  private readonly uniformLocations: Record<
    "modelViewProj" | "liftScale" | "pointSize" | "fillColor" | "roundDots",
    WebGLUniformLocation | null
  >;
  private readonly lineBuffer: WebGLBuffer;
  private lineVertexCount = 0;

  /**
   * Compile the overlay program and allocate the line buffer.
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
    this.lineBuffer = glContext.createBuffer()!;
  }

  /**
   * Upload the outline vertices for the current age.
   *
   * Usage: after reconstructOutlines; a count of 0 clears the wireframe.
   *
   * @param linePositions - ECEF positions in metres, xyz per vertex, in GL_LINES pairs.
   * @param vertexCount - Number of vertices to use from the start of the buffer (even).
   * @returns Nothing.
   */
  uploadLines(linePositions: Float32Array, vertexCount: number): void {
    this.lineVertexCount = vertexCount;
    if (!vertexCount) return;
    this.glContext.bindBuffer(this.glContext.ARRAY_BUFFER, this.lineBuffer);
    this.glContext.bufferData(this.glContext.ARRAY_BUFFER, linePositions.subarray(0, vertexCount * 3), this.glContext.DYNAMIC_DRAW);
  }

  /**
   * Draw the wireframe on top of the globe.
   *
   * Usage: after GlobeRenderer.drawFrame, before the selection overlay.
   *
   * @param modelViewProj - Camera matrix.
   * @param cameraHeightM - Camera height (sets the lift above the land).
   * @returns Nothing; restores the globe program.
   */
  drawOutlines(modelViewProj: Matrix4x4, cameraHeightM: number): void {
    if (!this.lineVertexCount) return;
    const glContext = this.glContext;
    glContext.useProgram(this.overlayProgram);
    glContext.depthFunc(glContext.LEQUAL);
    glContext.disableVertexAttribArray(this.globeNormalAttribute);
    glContext.uniformMatrix4fv(this.uniformLocations.modelViewProj, false, modelViewProj);
    // Lift above the land (coarse LODs float up to ~600 m) in proportion to the view distance.
    const liftMeters = Math.min(MAX_LIFT_M, Math.max(MIN_LIFT_M, cameraHeightM * LIFT_PER_HEIGHT));
    glContext.uniform1f(this.uniformLocations.liftScale, liftMeters / WGS84_SEMI_MAJOR);
    glContext.uniform1f(this.uniformLocations.roundDots, 0);
    glContext.uniform1f(this.uniformLocations.pointSize, 1);
    glContext.uniform4f(this.uniformLocations.fillColor, ...OUTLINE_COLOR);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.lineBuffer);
    glContext.enableVertexAttribArray(this.positionAttribute);
    glContext.vertexAttribPointer(this.positionAttribute, 3, glContext.FLOAT, false, 0, 0);
    glContext.drawArrays(glContext.LINES, 0, this.lineVertexCount);
    glContext.disableVertexAttribArray(this.positionAttribute);
    glContext.depthFunc(glContext.LESS);
    glContext.useProgram(this.globeProgram);
  }
}
