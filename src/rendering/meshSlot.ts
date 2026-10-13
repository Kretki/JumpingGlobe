/** GPU buffers holding one land mesh (base world layer or view detail). */

import type { LandMesh } from "../land/meshTypes";
import type { PlateMesh } from "../plates/reconstruct";

export class GpuMeshSlot {
  readonly positionBuffer: WebGLBuffer;
  readonly normalBuffer: WebGLBuffer;
  readonly indexBuffer: WebGLBuffer;
  indexCount = 0;

  /**
   * Allocate the three buffers.
   *
   * Usage: ``new GpuMeshSlot(glContext)`` per layer.
   *
   * @param glContext - WebGL context.
   */
  constructor(private readonly glContext: WebGLRenderingContext) {
    this.positionBuffer = glContext.createBuffer()!;
    this.normalBuffer = glContext.createBuffer()!;
    this.indexBuffer = glContext.createBuffer()!;
  }

  /**
   * Upload a static (present-day) mesh.
   *
   * Usage: present-day view detail.
   *
   * @param landMesh - Mesh to upload.
   * @returns Nothing.
   */
  uploadMesh(landMesh: LandMesh): void {
    const glContext = this.glContext;
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.positionBuffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, landMesh.positions, glContext.STATIC_DRAW);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.normalBuffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, landMesh.vertexNormals, glContext.STATIC_DRAW);
    glContext.bindBuffer(glContext.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    glContext.bufferData(glContext.ELEMENT_ARRAY_BUFFER, landMesh.triangleIndices, glContext.STATIC_DRAW);
    this.indexCount = landMesh.triangleIndices.length;
  }

  /**
   * Upload a reconstructed plate mesh.
   *
   * Usage: after every reconstruct; indices only change when the mesh itself does.
   *
   * @param plateMesh - Reconstructed mesh.
   * @param indicesChanged - Whether to re-upload the index buffer.
   * @returns Nothing.
   */
  uploadPlate(plateMesh: PlateMesh, indicesChanged: boolean): void {
    const glContext = this.glContext;
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.positionBuffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, plateMesh.positions, glContext.DYNAMIC_DRAW);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.normalBuffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, plateMesh.vertexNormals, glContext.DYNAMIC_DRAW);
    if (indicesChanged) {
      glContext.bindBuffer(glContext.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      glContext.bufferData(glContext.ELEMENT_ARRAY_BUFFER, plateMesh.triangleIndices, glContext.STATIC_DRAW);
      this.indexCount = plateMesh.triangleIndices.length;
    }
  }

  /**
   * Release the buffer contents (keeps the buffer objects).
   *
   * Usage: drop detail.
   *
   * @returns Nothing.
   */
  clearBuffers(): void {
    if (this.indexCount === 0) return;
    const glContext = this.glContext;
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.positionBuffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, 1, glContext.STATIC_DRAW);
    glContext.bindBuffer(glContext.ARRAY_BUFFER, this.normalBuffer);
    glContext.bufferData(glContext.ARRAY_BUFFER, 1, glContext.STATIC_DRAW);
    glContext.bindBuffer(glContext.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    glContext.bufferData(glContext.ELEMENT_ARRAY_BUFFER, 1, glContext.STATIC_DRAW);
    this.indexCount = 0;
  }

  /**
   * Delete the buffers.
   *
   * Usage: page teardown.
   *
   * @returns Nothing.
   */
  destroyBuffers(): void {
    this.clearBuffers();
    this.glContext.deleteBuffer(this.positionBuffer);
    this.glContext.deleteBuffer(this.normalBuffer);
    this.glContext.deleteBuffer(this.indexBuffer);
  }
}
