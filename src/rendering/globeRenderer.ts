/** Draws the ocean ellipsoid and the base/detail land layers. */

import type { BoundingBox } from "../land/boundingBox";
import { createEllipsoidMesh } from "./ellipsoidMesh";
import type { Matrix4x4 } from "./matrixMath";
import type { GpuMeshSlot } from "./meshSlot";
import { createProgram } from "./shaderProgram";
import { GLOBE_FRAGMENT_SHADER, GLOBE_VERTEX_SHADER } from "./shaderSources";

/**
 * Where the base (world) mesh is hidden because detail covers it: a lon/lat box
 * for present-day tiles, a spherical cap around the view centre in the past.
 */
export type LandClip =
  | { clipKind: "bbox"; clipBounds: BoundingBox }
  | { clipKind: "cap"; capCenter: [number, number, number]; cosRadius: number };

/** Per-frame camera matrices and eye position. */
export type FrameView = { modelViewProj: Matrix4x4; modelMatrix: Matrix4x4; eyePosition: number[] };

type RgbColor = [number, number, number];

/** Buffers and draw parameters of one mesh. */
type DrawCall = {
  positionBuffer: WebGLBuffer;
  normalBuffer: WebGLBuffer;
  indexBuffer: WebGLBuffer;
  indexCount: number;
  indexType: number;
  baseColor: RgbColor;
  landClip: LandClip | null;
};

const OCEAN_COLOR: RgbColor = [0.25, 0.55, 0.95];
const LAND_COLOR: RgbColor = [0.28, 0.62, 0.32];
const BACKGROUND_RGBA: [number, number, number, number] = [0.04, 0.06, 0.09, 1];
const OCEAN_LAT_BANDS = 64;
const OCEAN_LON_BANDS = 96;

export class GlobeRenderer {
  readonly globeProgram: WebGLProgram;
  readonly normalAttribute: number;
  private readonly positionAttribute: number;
  private readonly uniformLocations: Record<
    "modelViewProj" | "modelMatrix" | "cameraPos" | "baseColor" | "clipLand" | "clipBBox" | "clipCap",
    WebGLUniformLocation | null
  >;
  private readonly oceanPositions: WebGLBuffer;
  private readonly oceanNormals: WebGLBuffer;
  private readonly oceanIndices: WebGLBuffer;
  private readonly oceanIndexCount: number;

  /**
   * Compile the globe program and upload the ocean mesh.
   *
   * Usage: once at start-up.
   *
   * @param glContext - WebGL context.
   */
  constructor(private readonly glContext: WebGLRenderingContext) {
    this.globeProgram = createProgram(glContext, GLOBE_VERTEX_SHADER, GLOBE_FRAGMENT_SHADER);
    const ellipsoidMesh = createEllipsoidMesh(OCEAN_LAT_BANDS, OCEAN_LON_BANDS);
    this.oceanPositions = this.uploadBuffer(glContext.ARRAY_BUFFER, ellipsoidMesh.positions);
    this.oceanNormals = this.uploadBuffer(glContext.ARRAY_BUFFER, ellipsoidMesh.vertexNormals);
    this.oceanIndices = this.uploadBuffer(glContext.ELEMENT_ARRAY_BUFFER, ellipsoidMesh.triangleIndices);
    this.oceanIndexCount = ellipsoidMesh.triangleIndices.length;

    this.positionAttribute = glContext.getAttribLocation(this.globeProgram, "aPosition");
    this.normalAttribute = glContext.getAttribLocation(this.globeProgram, "aVertexNormal");
    const uniformOf = (uniformName: string) => glContext.getUniformLocation(this.globeProgram, uniformName);
    this.uniformLocations = {
      modelViewProj: uniformOf("uModelViewProj"),
      modelMatrix: uniformOf("uModelMatrix"),
      cameraPos: uniformOf("uCameraPos"),
      baseColor: uniformOf("uBaseColor"),
      clipLand: uniformOf("uClipLand"),
      clipBBox: uniformOf("uClipBBox"),
      clipCap: uniformOf("uClipCap"),
    };
  }

  /**
   * Create a buffer filled with static data.
   *
   * Usage: ocean buffers.
   *
   * @param bufferTarget - ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER.
   * @param bufferData - Data to upload.
   * @returns The buffer.
   */
  private uploadBuffer(bufferTarget: number, bufferData: Float32Array | Uint16Array): WebGLBuffer {
    const glBuffer = this.glContext.createBuffer()!;
    this.glContext.bindBuffer(bufferTarget, glBuffer);
    this.glContext.bufferData(bufferTarget, bufferData, this.glContext.STATIC_DRAW);
    return glBuffer;
  }

  /**
   * Set the land-clip uniforms.
   *
   * Usage: per draw call.
   *
   * @param landClip - Clip region, or null for none.
   * @returns Nothing.
   */
  private applyClip(landClip: LandClip | null): void {
    const glContext = this.glContext;
    if (landClip?.clipKind === "bbox") {
      const clipBounds = landClip.clipBounds;
      glContext.uniform1f(this.uniformLocations.clipLand, 1);
      glContext.uniform4f(
        this.uniformLocations.clipBBox,
        clipBounds.westEdge,
        clipBounds.southEdge,
        clipBounds.eastEdge,
        clipBounds.northEdge
      );
    } else if (landClip?.clipKind === "cap") {
      glContext.uniform1f(this.uniformLocations.clipLand, 2);
      glContext.uniform4f(
        this.uniformLocations.clipCap,
        landClip.capCenter[0],
        landClip.capCenter[1],
        landClip.capCenter[2],
        landClip.cosRadius
      );
    } else {
      glContext.uniform1f(this.uniformLocations.clipLand, 0);
    }
  }

  /**
   * Draw one indexed mesh with the globe program.
   *
   * Usage: ocean, base land and detail land.
   *
   * @param drawCall - Buffers, colour and clip.
   * @param frameView - Camera matrices.
   * @returns Nothing.
   */
  private drawMesh(drawCall: DrawCall, frameView: FrameView): void {
    const glContext = this.glContext;
    glContext.bindBuffer(glContext.ARRAY_BUFFER, drawCall.positionBuffer);
    glContext.enableVertexAttribArray(this.positionAttribute);
    glContext.vertexAttribPointer(this.positionAttribute, 3, glContext.FLOAT, false, 0, 0);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, drawCall.normalBuffer);
    glContext.enableVertexAttribArray(this.normalAttribute);
    glContext.vertexAttribPointer(this.normalAttribute, 3, glContext.FLOAT, false, 0, 0);
    glContext.bindBuffer(glContext.ELEMENT_ARRAY_BUFFER, drawCall.indexBuffer);
    glContext.uniformMatrix4fv(this.uniformLocations.modelViewProj, false, frameView.modelViewProj);
    glContext.uniformMatrix4fv(this.uniformLocations.modelMatrix, false, frameView.modelMatrix);
    const eyePosition = frameView.eyePosition;
    glContext.uniform3f(this.uniformLocations.cameraPos, eyePosition[0], eyePosition[1], eyePosition[2]);
    glContext.uniform3f(this.uniformLocations.baseColor, drawCall.baseColor[0], drawCall.baseColor[1], drawCall.baseColor[2]);
    this.applyClip(drawCall.landClip);
    glContext.drawElements(glContext.TRIANGLES, drawCall.indexCount, drawCall.indexType, 0);
  }

  /**
   * Draw a land slot (no-op when empty).
   *
   * Usage: base and detail layers.
   *
   * @param meshSlot - Slot to draw.
   * @param frameView - Camera matrices.
   * @param landClip - Region of the slot to hide, or null.
   * @returns Nothing.
   */
  private drawSlot(meshSlot: GpuMeshSlot, frameView: FrameView, landClip: LandClip | null): void {
    this.drawMesh(
      {
        positionBuffer: meshSlot.positionBuffer,
        normalBuffer: meshSlot.normalBuffer,
        indexBuffer: meshSlot.indexBuffer,
        indexCount: meshSlot.indexCount,
        indexType: this.glContext.UNSIGNED_INT,
        baseColor: LAND_COLOR,
        landClip,
      },
      frameView
    );
  }

  /**
   * Clear the frame and draw ocean, base land and detail land.
   *
   * Usage: once per animation frame, before overlays.
   *
   * @param frameView - Camera matrices.
   * @param baseSlot - World layer.
   * @param detailSlot - View detail layer.
   * @param detailClip - Part of the base hidden while detail is shown.
   * @returns Nothing; leaves the globe program bound.
   */
  drawFrame(frameView: FrameView, baseSlot: GpuMeshSlot, detailSlot: GpuMeshSlot, detailClip: LandClip | null): void {
    const glContext = this.glContext;
    glContext.clearColor(...BACKGROUND_RGBA);
    glContext.clear(glContext.COLOR_BUFFER_BIT | glContext.DEPTH_BUFFER_BIT);
    glContext.enable(glContext.DEPTH_TEST);
    glContext.enable(glContext.CULL_FACE);
    glContext.cullFace(glContext.BACK);
    glContext.useProgram(this.globeProgram);

    this.drawMesh(
      {
        positionBuffer: this.oceanPositions,
        normalBuffer: this.oceanNormals,
        indexBuffer: this.oceanIndices,
        indexCount: this.oceanIndexCount,
        indexType: glContext.UNSIGNED_SHORT,
        baseColor: OCEAN_COLOR,
        landClip: null,
      },
      frameView
    );

    glContext.enable(glContext.CULL_FACE);
    glContext.frontFace(glContext.CCW);
    glContext.cullFace(glContext.BACK);
    if (baseSlot.indexCount > 0) this.drawSlot(baseSlot, frameView, detailSlot.indexCount > 0 ? detailClip : null);
    if (detailSlot.indexCount > 0) {
      glContext.enable(glContext.POLYGON_OFFSET_FILL);
      glContext.polygonOffset(-1, -1);
      this.drawSlot(detailSlot, frameView, null);
      glContext.disable(glContext.POLYGON_OFFSET_FILL);
    }
  }
}
