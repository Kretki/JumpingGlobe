/** Draws groups of coloured 3-D lines (TPW grid and rods, magnetic poles and field lines), each with its own radial scale. */

import type { Matrix4x4 } from "./matrixMath";
import { createProgram } from "./shaderProgram";
import { SPACE_LINE_FRAGMENT_SHADER, SPACE_LINE_VERTEX_SHADER } from "./shaderSources";

/** Line data of one group: flat xyz (ECEF metres) and rgba per vertex. */
export interface SpaceLineData {
  readonly positionValues: number[];
  readonly colorValues: number[];
}

/** GPU buffers of one group. */
type GroupBuffers = { positionBuffer: WebGLBuffer; colorBuffer: WebGLBuffer; vertexCount: number; radialScale: number };

export class SpaceLineOverlay<GroupKey extends string> {
  private readonly lineProgram: WebGLProgram;
  private readonly positionAttribute: number;
  private readonly colorAttribute: number;
  private readonly modelViewProjUniform: WebGLUniformLocation | null;
  private readonly radialScaleUniform: WebGLUniformLocation | null;
  private readonly buffersByGroup = new Map<GroupKey, GroupBuffers>();

  /**
   * Compile the line program.
   *
   * Usage: once at start-up.
   *
   * @param glContext - WebGL context.
   * @param globeProgram - Program restored after drawing.
   * @param globeNormalAttribute - Globe normal attribute, disabled while drawing.
   * @param groupOrder - Groups in drawing order.
   */
  constructor(
    private readonly glContext: WebGLRenderingContext,
    private readonly globeProgram: WebGLProgram,
    private readonly globeNormalAttribute: number,
    private readonly groupOrder: readonly GroupKey[]
  ) {
    this.lineProgram = createProgram(glContext, SPACE_LINE_VERTEX_SHADER, SPACE_LINE_FRAGMENT_SHADER);
    this.positionAttribute = glContext.getAttribLocation(this.lineProgram, "aLinePos");
    this.colorAttribute = glContext.getAttribLocation(this.lineProgram, "aLineColor");
    this.modelViewProjUniform = glContext.getUniformLocation(this.lineProgram, "uModelViewProj");
    this.radialScaleUniform = glContext.getUniformLocation(this.lineProgram, "uRadialScale");
  }

  /**
   * Buffers of a group, created on first use.
   *
   * Usage: uploadGroups.
   *
   * @param groupKey - Group.
   * @returns Its buffers.
   */
  private buffersFor(groupKey: GroupKey): GroupBuffers {
    let groupBuffers = this.buffersByGroup.get(groupKey);
    if (!groupBuffers) {
      groupBuffers = { positionBuffer: this.glContext.createBuffer()!, colorBuffer: this.glContext.createBuffer()!, vertexCount: 0, radialScale: 1 };
      this.buffersByGroup.set(groupKey, groupBuffers);
    }
    return groupBuffers;
  }

  /**
   * Replace the drawn lines; groups missing from the map are cleared.
   *
   * Usage: after the scene was rebuilt.
   *
   * @param lineGroups - Line data per group.
   * @returns Nothing.
   */
  uploadGroups(lineGroups: ReadonlyMap<GroupKey, SpaceLineData>): void {
    const glContext = this.glContext;
    for (const groupKey of this.groupOrder) {
      const lineData = lineGroups.get(groupKey);
      const groupBuffers = this.buffersFor(groupKey);
      groupBuffers.vertexCount = lineData ? lineData.positionValues.length / 3 : 0;
      if (!lineData || !groupBuffers.vertexCount) continue;
      glContext.bindBuffer(glContext.ARRAY_BUFFER, groupBuffers.positionBuffer);
      glContext.bufferData(glContext.ARRAY_BUFFER, new Float32Array(lineData.positionValues), glContext.DYNAMIC_DRAW);
      glContext.bindBuffer(glContext.ARRAY_BUFFER, groupBuffers.colorBuffer);
      glContext.bufferData(glContext.ARRAY_BUFFER, new Float32Array(lineData.colorValues), glContext.DYNAMIC_DRAW);
    }
  }

  /**
   * Set how far a group is pushed out from the Earth's centre.
   *
   * Usage: every frame (the TPW grid's lift follows the zoom).
   *
   * @param groupKey - Group.
   * @param radialScale - Factor applied to every position (1 = as uploaded).
   * @returns Nothing.
   */
  setRadialScale(groupKey: GroupKey, radialScale: number): void {
    this.buffersFor(groupKey).radialScale = radialScale;
  }

  /**
   * Stop drawing anything.
   *
   * Usage: every paleomagnetic layer is off or has no data.
   *
   * @returns Nothing.
   */
  clearGroups(): void {
    for (const groupBuffers of this.buffersByGroup.values()) groupBuffers.vertexCount = 0;
  }

  /**
   * Whether any group has lines.
   *
   * Usage: skip drawing.
   *
   * @returns True when something is uploaded.
   */
  get hasLines(): boolean {
    return [...this.buffersByGroup.values()].some((groupBuffers) => groupBuffers.vertexCount > 0);
  }

  /**
   * Draw one group.
   *
   * Usage: drawLines.
   *
   * @param groupBuffers - Group.
   * @returns Nothing.
   */
  private drawGroup(groupBuffers: GroupBuffers): void {
    const glContext = this.glContext;
    glContext.uniform1f(this.radialScaleUniform, groupBuffers.radialScale);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, groupBuffers.positionBuffer);
    glContext.vertexAttribPointer(this.positionAttribute, 3, glContext.FLOAT, false, 0, 0);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, groupBuffers.colorBuffer);
    glContext.vertexAttribPointer(this.colorAttribute, 4, glContext.FLOAT, false, 0, 0);
    glContext.drawArrays(glContext.LINES, 0, groupBuffers.vertexCount);
  }

  /**
   * Draw every group (depth-tested, so the globe hides lines behind it).
   *
   * Usage: frame loop, after the globe and the plate layers.
   *
   * @param modelViewProj - Camera matrix.
   * @returns Nothing; restores the globe program.
   */
  drawLines(modelViewProj: Matrix4x4): void {
    const glContext = this.glContext;
    glContext.useProgram(this.lineProgram);
    glContext.depthFunc(glContext.LEQUAL);
    glContext.enable(glContext.BLEND);
    glContext.blendFunc(glContext.SRC_ALPHA, glContext.ONE_MINUS_SRC_ALPHA);
    glContext.disableVertexAttribArray(this.globeNormalAttribute);
    glContext.uniformMatrix4fv(this.modelViewProjUniform, false, modelViewProj);
    glContext.enableVertexAttribArray(this.positionAttribute);
    glContext.enableVertexAttribArray(this.colorAttribute);
    for (const groupKey of this.groupOrder) {
      const groupBuffers = this.buffersByGroup.get(groupKey);
      if (groupBuffers?.vertexCount) this.drawGroup(groupBuffers);
    }
    glContext.disableVertexAttribArray(this.colorAttribute);
    glContext.disableVertexAttribArray(this.positionAttribute);
    glContext.disable(glContext.BLEND);
    glContext.depthFunc(glContext.LESS);
    glContext.useProgram(this.globeProgram);
  }
}
