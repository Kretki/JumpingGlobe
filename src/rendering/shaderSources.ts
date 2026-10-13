/** GLSL sources of the globe (ocean + land) and the selection overlay. */

export const GLOBE_VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aVertexNormal;
uniform mat4 uModelViewProj;
uniform mat4 uModelMatrix;
varying vec3 vSurfaceNormal;
varying vec3 vWorldPos;

void main() {
  vec4 worldPosition = uModelMatrix * vec4(aPosition, 1.0);
  vWorldPos = worldPosition.xyz;
  vSurfaceNormal = mat3(uModelMatrix) * aVertexNormal;
  gl_Position = uModelViewProj * vec4(aPosition, 1.0);
}
`;

export const GLOBE_FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float; // lon/lat clip test needs more than mediump's ~0.1°
#else
precision mediump float;
#endif
varying vec3 vSurfaceNormal;
varying vec3 vWorldPos;
uniform vec3 uCameraPos;
uniform vec3 uBaseColor;
uniform float uClipLand;  // 0 none · 1 lon/lat box · 2 spherical cap
uniform vec4 uClipBBox;
uniform vec4 uClipCap;    // cap centre (unit vector, GPlates sphere) + cos(radius)

void main() {
  if (uClipLand > 0.5) {
    float lonRadians = atan(vWorldPos.y, vWorldPos.x);
    // Geodetic latitude (same as the EPSG:4326 data); for near-surface points
    // tan(geodetic) = z / ((1 - e²) p). Geocentric would be off by up to 0.19°.
    float latRadians = atan(vWorldPos.z, 0.99330562 * length(vWorldPos.xy));
    if (uClipLand < 1.5) {
      float lonDegrees = lonRadians * 57.2957795;
      float latDegrees = latRadians * 57.2957795;
      bool insideLat = latDegrees >= uClipBBox.y && latDegrees <= uClipBBox.w;
      bool insideLon = uClipBBox.x <= uClipBBox.z
        ? (lonDegrees >= uClipBBox.x && lonDegrees <= uClipBBox.z)
        : (lonDegrees >= uClipBBox.x || lonDegrees <= uClipBBox.z);
      if (insideLat && insideLon) discard;
    } else {
      vec3 unitDirection = vec3(cos(latRadians) * cos(lonRadians), cos(latRadians) * sin(lonRadians), sin(latRadians));
      if (dot(unitDirection, uClipCap.xyz) >= uClipCap.w) discard;
    }
  }

  // Lit evenly from all directions: no sun, so no dark side or hot spot; a soft
  // view-facing term keeps the globe readable as a sphere.
  vec3 normalDirection = normalize(vSurfaceNormal);
  vec3 viewDirection = normalize(uCameraPos - vWorldPos);
  float facingTerm = max(dot(normalDirection, viewDirection), 0.0);
  gl_FragColor = vec4(uBaseColor * (0.8 + 0.2 * facingTerm), 1.0);
}
`;

export const OVERLAY_VERTEX_SHADER = `
attribute vec3 aOverlayPos;
uniform mat4 uModelViewProj;
uniform float uLiftScale;
uniform float uPointSize;
void main() {
  gl_Position = uModelViewProj * vec4(aOverlayPos * (1.0 + uLiftScale), 1.0);
  gl_PointSize = uPointSize;
}
`;

export const OVERLAY_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 uFillColor;
uniform float uRoundDots;
void main() {
  if (uRoundDots > 0.5) {
    vec2 pointOffset = gl_PointCoord - 0.5;
    if (dot(pointOffset, pointOffset) > 0.25) discard;
  }
  gl_FragColor = uFillColor;
}
`;
