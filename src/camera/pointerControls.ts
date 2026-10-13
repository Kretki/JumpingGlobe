/** Pointer input on the canvas: drag to orbit, wheel to zoom, click to select. */

import type { OrbitCamera } from "./orbitCamera";

/** A press counts as a click when it moved at most this far … */
const CLICK_MAX_MOVE_PX = 4;
/** … and was released within this time. */
const CLICK_MAX_DURATION_MS = 600;

export type ClickHandler = (pointerClientX: number, pointerClientY: number) => void;

/**
 * Wire orbit, zoom and click handling to a canvas.
 *
 * Usage: once at start-up.
 *
 * @param canvasElement - Canvas receiving the events.
 * @param orbitCamera - Camera to move.
 * @param onGlobeClick - Called for clicks (not drags) with client coordinates.
 * @returns Nothing.
 */
export function attachPointerControls(canvasElement: HTMLCanvasElement, orbitCamera: OrbitCamera, onGlobeClick: ClickHandler): void {
  let isDragging = false;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let pressPointX = 0;
  let pressPointY = 0;
  let pressTimeMs = 0;

  canvasElement.addEventListener("pointerdown", (pointerEvent) => {
    isDragging = true;
    lastPointerX = pressPointX = pointerEvent.clientX;
    lastPointerY = pressPointY = pointerEvent.clientY;
    pressTimeMs = performance.now();
    canvasElement.setPointerCapture(pointerEvent.pointerId);
  });

  canvasElement.addEventListener("pointerup", (pointerEvent) => {
    isDragging = false;
    const movedPixels = Math.hypot(pointerEvent.clientX - pressPointX, pointerEvent.clientY - pressPointY);
    if (movedPixels > CLICK_MAX_MOVE_PX || performance.now() - pressTimeMs > CLICK_MAX_DURATION_MS) return;
    onGlobeClick(pointerEvent.clientX, pointerEvent.clientY);
  });

  canvasElement.addEventListener("pointermove", (pointerEvent) => {
    if (!isDragging) return;
    const deltaAlongX = pointerEvent.clientX - lastPointerX;
    const deltaAlongY = pointerEvent.clientY - lastPointerY;
    lastPointerX = pointerEvent.clientX;
    lastPointerY = pointerEvent.clientY;
    orbitCamera.orbitByDrag(deltaAlongX, deltaAlongY, canvasElement.clientHeight);
  });

  canvasElement.addEventListener(
    "wheel",
    (wheelEvent) => {
      wheelEvent.preventDefault();
      orbitCamera.zoomByWheel(wheelEvent.deltaY);
    },
    { passive: false }
  );
}
