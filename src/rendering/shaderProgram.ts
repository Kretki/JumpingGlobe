/** Compile and link WebGL shader programs. */

/**
 * Compile one shader.
 *
 * Usage: building blocks of createProgram.
 *
 * @param glContext - WebGL context.
 * @param shaderType - gl.VERTEX_SHADER or gl.FRAGMENT_SHADER.
 * @param sourceText - GLSL source.
 * @returns The compiled shader.
 * @throws Error with the compiler log on failure.
 */
export function compileShader(glContext: WebGLRenderingContext, shaderType: number, sourceText: string): WebGLShader {
  const shaderObject = glContext.createShader(shaderType)!;
  glContext.shaderSource(shaderObject, sourceText);
  glContext.compileShader(shaderObject);
  if (!glContext.getShaderParameter(shaderObject, glContext.COMPILE_STATUS)) {
    const compileLog = glContext.getShaderInfoLog(shaderObject);
    glContext.deleteShader(shaderObject);
    throw new Error(compileLog || "Shader compile failed");
  }
  return shaderObject;
}

/**
 * Compile and link a program from vertex and fragment sources.
 *
 * Usage: once per program at start-up.
 *
 * @param glContext - WebGL context.
 * @param vertexSource - Vertex shader GLSL.
 * @param fragmentSource - Fragment shader GLSL.
 * @returns The linked program.
 * @throws Error with the linker log on failure.
 */
export function createProgram(glContext: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const programObject = glContext.createProgram()!;
  glContext.attachShader(programObject, compileShader(glContext, glContext.VERTEX_SHADER, vertexSource));
  glContext.attachShader(programObject, compileShader(glContext, glContext.FRAGMENT_SHADER, fragmentSource));
  glContext.linkProgram(programObject);
  if (!glContext.getProgramParameter(programObject, glContext.LINK_STATUS)) {
    throw new Error(glContext.getProgramInfoLog(programObject) || "Program link failed");
  }
  return programObject;
}
