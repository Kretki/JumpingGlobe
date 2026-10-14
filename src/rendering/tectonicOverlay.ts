/** Draws the tectonic scene (boundary symbols, motion ticks, plate fills and highlights) over the globe. */

import { WGS84_SEMI_MAJOR, writeSurfacePoint } from "../geodesy/wgs84Ellipsoid";
import type { SymbolGeometry } from "../plates/symbols/symbolGeometry";
import type { TectonicStyle } from "../plates/symbols/tectonicScene";
import type { Matrix4x4 } from "./matrixMath";
import { createProgram } from "./shaderProgram";
import { OVERLAY_FRAGMENT_SHADER, OVERLAY_VERTEX_SHADER } from "./shaderSources";
import { TECTONIC_COLORS, TECTONIC_DRAW_ORDER } from "./tectonicStyle";

/** GPU buffers of one style. */
type StyleBuffers = { lineBuffer: WebGLBuffer; lineVertexCount: number; triangleBuffer: WebGLBuffer; triangleVertexCount: number };

const MAX_LIFT_M = 35_000;
const MIN_LIFT_M = 25;
const LIFT_PER_HEIGHT = 0.0035;

/**
 * ECEF positions of unit vectors on the ellipsoid.
 *
 * Usage: before uploading symbol geometry.
 *
 * @param unitValues - Flat xyz unit vectors.
 * @returns Float32Array of ECEF metres.
 */
export function unitValuesToPositions(unitValues: number[]): Float32Array {
  const positionData = new Float32Array(unitValues.length);
  for (let valueIdx = 0; valueIdx < unitValues.length; valueIdx += 3) {
    writeSurfacePoint([unitValues[valueIdx], unitValues[valueIdx + 1], unitValues[valueIdx + 2]], positionData, valueIdx);
  }
  return positionData;
}

export class TectonicOverlay {
  private readonly overlayProgram: WebGLProgram;
  private readonly positionAttribute: number;
  private readonly uniformLocations: Record<"modelViewProj" | "liftScale" | "pointSize" | "fillColor" | "roundDots", WebGLUniformLocation | null>;
  private readonly buffersByStyle = new Map<TectonicStyle, StyleBuffers>();

  /**
   * Compile the overlay program.
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
  }

  /**
   * Buffers of a style, created on first use.
   *
   * Usage: uploadScene.
   *
   * @param tectonicStyle - Style.
   * @returns Its buffers.
   */
  private buffersFor(tectonicStyle: TectonicStyle): StyleBuffers {
    let styleBuffers = this.buffersByStyle.get(tectonicStyle);
    if (!styleBuffers) {
      styleBuffers = { lineBuffer: this.glContext.createBuffer()!, lineVertexCount: 0, triangleBuffer: this.glContext.createBuffer()!, triangleVertexCount: 0 };
      this.buffersByStyle.set(tectonicStyle, styleBuffers);
    }
    return styleBuffers;
  }

  /**
   * Upload a flat unit-vector list to a buffer.
   *
   * Usage: lines and triangles of each style.
   *
   * @param glBuffer - Target buffer.
   * @param unitValues - Flat xyz unit vectors.
   * @returns Vertex count uploaded.
   */
  private uploadValues(glBuffer: WebGLBuffer, unitValues: number[]): number {
    if (!unitValues.length) return 0;
    this.glContext.bindBuffer(this.glContext.ARRAY_BUFFER, glBuffer);
    this.glContext.bufferData(this.glContext.ARRAY_BUFFER, unitValuesToPositions(unitValues), this.glContext.DYNAMIC_DRAW);
    return unitValues.length / 3;
  }

  /**
   * Replace the drawn scene.
   *
   * Usage: after buildTectonicScene; styles missing from the map are cleared.
   *
   * @param styledGeometry - Geometry per style.
   * @returns Nothing.
   */
  uploadScene(styledGeometry: Map<TectonicStyle, SymbolGeometry>): void {
    for (const tectonicStyle of TECTONIC_DRAW_ORDER) {
      const symbolGeometry = styledGeometry.get(tectonicStyle);
      const styleBuffers = this.buffersFor(tectonicStyle);
      styleBuffers.lineVertexCount = symbolGeometry ? this.uploadValues(styleBuffers.lineBuffer, symbolGeometry.lineValues) : 0;
      styleBuffers.triangleVertexCount = symbolGeometry ? this.uploadValues(styleBuffers.triangleBuffer, symbolGeometry.triangleValues) : 0;
    }
  }

  /**
   * Stop drawing anything.
   *
   * Usage: when every tectonic layer is switched off.
   *
   * @returns Nothing.
   */
  clearScene(): void {
    for (const styleBuffers of this.buffersByStyle.values()) styleBuffers.lineVertexCount = styleBuffers.triangleVertexCount = 0;
  }

  /**
   * Draw one style's primitives.
   *
   * Usage: drawScene, in TECTONIC_DRAW_ORDER.
   *
   * @param tectonicStyle - Style.
   * @param styleBuffers - Its buffers.
   * @returns Nothing.
   */
  private drawStyle(tectonicStyle: TectonicStyle, styleBuffers: StyleBuffers): void {
    const glContext = this.glContext;
    const styleColor = TECTONIC_COLORS[tectonicStyle];
    const isTranslucent = styleColor[3] < 1;
    glContext.uniform4f(this.uniformLocations.fillColor, ...styleColor);
    if (isTranslucent) {
      glContext.enable(glContext.BLEND);
      glContext.blendFunc(glContext.SRC_ALPHA, glContext.ONE_MINUS_SRC_ALPHA);
      glContext.depthMask(false);
    }
    for (const [glBuffer, vertexCount, primitiveMode] of [
      [styleBuffers.triangleBuffer, styleBuffers.triangleVertexCount, glContext.TRIANGLES],
      [styleBuffers.lineBuffer, styleBuffers.lineVertexCount, glContext.LINES],
    ] as const) {
      if (!vertexCount) continue;
      glContext.bindBuffer(glContext.ARRAY_BUFFER, glBuffer);
      glContext.vertexAttribPointer(this.positionAttribute, 3, glContext.FLOAT, false, 0, 0);
      glContext.drawArrays(primitiveMode, 0, vertexCount);
    }
    if (isTranslucent) {
      glContext.depthMask(true);
      glContext.disable(glContext.BLEND);
    }
  }

  /**
   * Draw the scene on top of the globe.
   *
   * Usage: after GlobeRenderer.drawFrame (and the outline wireframe), before the selection overlay.
   *
   * @param modelViewProj - Camera matrix.
   * @param cameraHeightM - Camera height (sets the lift above the land).
   * @returns Nothing; restores the globe program.
   */
  drawScene(modelViewProj: Matrix4x4, cameraHeightM: number): void {
    const glContext = this.glContext;
    glContext.useProgram(this.overlayProgram);
    glContext.depthFunc(glContext.LEQUAL);
    glContext.disable(glContext.CULL_FACE);
    glContext.disableVertexAttribArray(this.globeNormalAttribute);
    glContext.uniformMatrix4fv(this.uniformLocations.modelViewProj, false, modelViewProj);
    const liftMeters = Math.min(MAX_LIFT_M, Math.max(MIN_LIFT_M, cameraHeightM * LIFT_PER_HEIGHT));
    glContext.uniform1f(this.uniformLocations.liftScale, liftMeters / WGS84_SEMI_MAJOR);
    glContext.uniform1f(this.uniformLocations.roundDots, 0);
    glContext.uniform1f(this.uniformLocations.pointSize, 1);
    glContext.enableVertexAttribArray(this.positionAttribute);
    for (const tectonicStyle of TECTONIC_DRAW_ORDER) {
      const styleBuffers = this.buffersByStyle.get(tectonicStyle);
      if (styleBuffers) this.drawStyle(tectonicStyle, styleBuffers);
    }
    glContext.disableVertexAttribArray(this.positionAttribute);
    glContext.enable(glContext.CULL_FACE);
    glContext.depthFunc(glContext.LESS);
    glContext.useProgram(this.globeProgram);
  }
}
