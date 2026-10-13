/** Entry point: build the globe, wire camera, timeline, land layers and selection, and run the frame loop. */

import { LandLayerController } from "./app/landLayerController";
import { PlateLayerTracker } from "./app/plateLayerTracker";
import { PointSelection } from "./app/pointSelection";
import { timelineStatusText } from "./app/timelineStatus";
import { pickGlobe } from "./camera/globePicking";
import { FIELD_OF_VIEW_Y, OrbitCamera } from "./camera/orbitCamera";
import { attachPointerControls } from "./camera/pointerControls";
import { ecefToGeodeticHeight, WGS84_SEMI_MAJOR } from "./geodesy/wgs84Ellipsoid";
import { LandLoader } from "./land/landLoader";
import { lodFileFromHeight, WORLD_FILE } from "./land/lod.config";
import { GlobeRenderer } from "./rendering/globeRenderer";
import { mat4Identity, mat4LookAt, mat4Multiply, mat4Perspective } from "./rendering/matrixMath";
import { GpuMeshSlot } from "./rendering/meshSlot";
import { SelectionOverlay } from "./rendering/selectionOverlay";
import { CoordinatesPanel } from "./ui/coordinatesPanel";
import { requireElement } from "./ui/domLookup";
import { LandProgressPanel } from "./ui/landProgressPanel";
import { SelectionPanel } from "./ui/selectionPanel";
import { TimelineControl } from "./ui/timelineControl";

const API_BASE_URL = "/api";
const MAX_PIXEL_RATIO = 2;

/** Everything the frame loop needs. */
type GlobeApplication = {
  canvasElement: HTMLCanvasElement;
  glContext: WebGLRenderingContext;
  orbitCamera: OrbitCamera;
  globeRenderer: GlobeRenderer;
  selectionOverlay: SelectionOverlay;
  baseSlot: GpuMeshSlot;
  detailSlot: GpuMeshSlot;
  timeline: TimelineControl;
  plateTracker: PlateLayerTracker;
  landLayers: LandLayerController;
  pointSelection: PointSelection;
  coordinatesPanel: CoordinatesPanel;
  refreshTimelineStatus: () => void;
};

/**
 * Get a WebGL context with 32-bit indices if possible.
 *
 * Usage: start-up.
 *
 * @param canvasElement - Target canvas.
 * @returns The context.
 * @throws Error when WebGL is unavailable.
 */
function createGlContext(canvasElement: HTMLCanvasElement): WebGLRenderingContext {
  const glContext = canvasElement.getContext("webgl");
  if (!glContext) throw new Error("WebGL not supported");
  if (!glContext.getExtension("OES_element_index_uint")) {
    console.warn("OES_element_index_uint missing — large land meshes may fail");
  }
  return glContext;
}

/**
 * Create the timeline control from its DOM elements.
 *
 * Usage: start-up.
 *
 * @param onAgeChange - Called when the age changes.
 * @returns The control.
 */
function createTimeline(onAgeChange: (ageInMyr: number) => void): TimelineControl {
  return new TimelineControl(
    {
      ageSlider: requireElement("tl-age", HTMLInputElement),
      ageReadout: requireElement("tl-readout", HTMLOutputElement),
      playButton: requireElement("tl-play", HTMLButtonElement),
      speedSelect: requireElement("tl-speed", HTMLSelectElement),
      reverseCheckbox: requireElement("tl-reverse", HTMLInputElement),
      startLabel: requireElement("tl-start", HTMLSpanElement),
      endLabel: requireElement("tl-end", HTMLSpanElement),
      statusElement: requireElement("tl-status", HTMLSpanElement),
    },
    onAgeChange
  );
}

/**
 * Create the land progress card from its DOM elements.
 *
 * Usage: start-up.
 *
 * @returns The panel.
 */
function createProgressPanel(): LandProgressPanel {
  const panelElement = requireElement("land-progress", HTMLDivElement);
  const percentElement = panelElement.querySelector(".pct");
  if (!(percentElement instanceof HTMLElement)) throw new Error("#land-progress .pct is missing");
  return new LandProgressPanel({
    panelElement,
    fillElement: requireElement("land-progress-fill", HTMLElement),
    labelElement: requireElement("land-progress-label", HTMLDivElement),
    percentElement,
  });
}

/**
 * Create the selection panel from its DOM elements.
 *
 * Usage: start-up.
 *
 * @param onClearRequest - Called when the user clears the selection.
 * @returns The panel.
 */
function createSelectionPanel(onClearRequest: () => void): SelectionPanel {
  return new SelectionPanel(
    {
      panelElement: requireElement("point-panel", HTMLElement),
      plateElement: requireElement("pp-plate", HTMLElement),
      presentElement: requireElement("pp-present", HTMLElement),
      ageLabelElement: requireElement("pp-age-label", HTMLElement),
      positionElement: requireElement("pp-at", HTMLElement),
      trackElement: requireElement("pp-track", HTMLElement),
      noteElement: requireElement("pp-note", HTMLElement),
      clearButton: requireElement("pp-clear", HTMLButtonElement),
    },
    onClearRequest
  );
}

/**
 * Build and wire every component.
 *
 * Usage: once at page load.
 *
 * @returns The wired application.
 */
function createApplication(): GlobeApplication {
  const canvasElement = requireElement("gl", HTMLCanvasElement);
  const glContext = createGlContext(canvasElement);
  const orbitCamera = new OrbitCamera();
  const globeRenderer = new GlobeRenderer(glContext);
  const selectionOverlay = new SelectionOverlay(glContext, globeRenderer.globeProgram, globeRenderer.normalAttribute);
  const baseSlot = new GpuMeshSlot(glContext);
  const detailSlot = new GpuMeshSlot(glContext);

  // Late-bound references: the components below refer to each other through callbacks.
  let landLayers: LandLayerController | null = null;
  let plateTracker: PlateLayerTracker | null = null;
  const timeline = createTimeline((ageInMyr) => landLayers?.handleAgeChange(ageInMyr));

  const refreshTimelineStatus = () => {
    if (!plateTracker || !landLayers) return;
    timeline.setStatus(
      timelineStatusText({
        rotationModelError: plateTracker.rotationModelError,
        buildStatus: plateTracker.buildStatus,
        statusDetail: plateTracker.statusDetail,
        plateFiles: plateTracker.plateFiles,
        hiddenPlateGroups: landLayers.hiddenPlateGroups,
        ageInMyr: timeline.currentAgeMa,
        cameraHeightM: orbitCamera.heightMeters,
        isPlaying: timeline.isPlaying,
      })
    );
  };

  plateTracker = new PlateLayerTracker(
    {
      onRotationModel: (maxAgeMa) => {
        timeline.enableControls(maxAgeMa);
        landLayers?.markAgeDirty();
      },
      onWorldTwin: (twinFile) => void landLayers?.loadPlateWorld(twinFile),
      onStatusChange: refreshTimelineStatus,
    },
    () => landLayers?.isDisposed ?? false
  );

  landLayers = new LandLayerController({
    createLoader: (onProgress) => new LandLoader(API_BASE_URL, onProgress),
    baseSlot,
    detailSlot,
    progressPanel: createProgressPanel(),
    plateTracker,
    ageSource: timeline,
    cameraHeight: () => orbitCamera.heightMeters,
    viewportAspect: () => canvasElement.width / Math.max(canvasElement.height, 1),
    onStatusChange: refreshTimelineStatus,
  });

  let pointSelection: PointSelection | null = null;
  const selectionPanel = createSelectionPanel(() => pointSelection?.clearSelection());
  pointSelection = new PointSelection({ plateTracker, ageSource: timeline, selectionPanel, selectionOverlay });

  attachPointerControls(canvasElement, orbitCamera, (pointerClientX, pointerClientY) => {
    const pickedLonLat = pickGlobe(orbitCamera, canvasElement.getBoundingClientRect(), pointerClientX, pointerClientY);
    if (pickedLonLat) void pointSelection?.selectAt(pickedLonLat[0], pickedLonLat[1]);
  });

  return {
    canvasElement,
    glContext,
    orbitCamera,
    globeRenderer,
    selectionOverlay,
    baseSlot,
    detailSlot,
    timeline,
    plateTracker,
    landLayers,
    pointSelection,
    coordinatesPanel: new CoordinatesPanel(requireElement("coords", HTMLDivElement)),
    refreshTimelineStatus,
  };
}

/**
 * Match the canvas backing store to its displayed size (capped at 2× pixel ratio).
 *
 * Usage: start of every frame.
 *
 * @param canvasElement - Canvas.
 * @param glContext - Its WebGL context.
 * @returns Nothing.
 */
function resizeCanvas(canvasElement: HTMLCanvasElement, glContext: WebGLRenderingContext): void {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const targetWidth = Math.floor(window.innerWidth * pixelRatio);
  const targetHeight = Math.floor(window.innerHeight * pixelRatio);
  if (canvasElement.width !== targetWidth || canvasElement.height !== targetHeight) {
    canvasElement.width = targetWidth;
    canvasElement.height = targetHeight;
    glContext.viewport(0, 0, targetWidth, targetHeight);
  }
}

/**
 * Update the read-out and schedule land loads for the look-at point.
 *
 * Usage: every frame, before drawing.
 *
 * @param globeApp - Application.
 * @param surfacePoint - Look-at point (ECEF).
 * @returns Nothing.
 */
function updateViewState(globeApp: GlobeApplication, surfacePoint: number[]): void {
  const lookAtPoint = ecefToGeodeticHeight(surfacePoint[0], surfacePoint[1], surfacePoint[2]);
  const heightMeters = globeApp.orbitCamera.heightMeters;
  const ageInMyr = globeApp.timeline.currentAgeMa;
  globeApp.coordinatesPanel.updateReadout({
    latitudeDeg: lookAtPoint.latitudeDeg,
    longitudeDeg: lookAtPoint.longitudeDeg,
    surfaceEcef: surfacePoint,
    cameraHeightM: heightMeters,
    lodFileName: ageInMyr > 0 && globeApp.timeline.isPlaying ? WORLD_FILE : lodFileFromHeight(heightMeters),
    ageInMyr,
    landStatus: globeApp.landLayers.landStatus,
  });
  globeApp.landLayers.scheduleLandLoad(lookAtPoint.longitudeDeg, lookAtPoint.latitudeDeg, heightMeters);
}

/**
 * Render one frame.
 *
 * Usage: requestAnimationFrame callback chain.
 *
 * @param globeApp - Application.
 * @param deltaSeconds - Time since the previous frame.
 * @returns Nothing.
 */
function renderFrame(globeApp: GlobeApplication, deltaSeconds: number): void {
  globeApp.timeline.advanceFrame(deltaSeconds);
  if (globeApp.landLayers.applyAge()) {
    globeApp.pointSelection.refreshPanel();
    globeApp.refreshTimelineStatus();
  }
  resizeCanvas(globeApp.canvasElement, globeApp.glContext);
  const orbitCamera = globeApp.orbitCamera;
  const eyePosition = orbitCamera.cameraPosition();
  updateViewState(globeApp, orbitCamera.lookAtSurfacePoint());

  const aspectRatio = globeApp.canvasElement.width / globeApp.canvasElement.height;
  const nearPlane = Math.max(1, orbitCamera.heightMeters * 0.05);
  const farPlane = orbitCamera.heightMeters + WGS84_SEMI_MAJOR * 4;
  const projectionMatrix = mat4Perspective(FIELD_OF_VIEW_Y, aspectRatio, nearPlane, farPlane);
  const viewMatrix = mat4LookAt(eyePosition, [0, 0, 0], orbitCamera.upVector());
  const modelMatrix = mat4Identity();
  const modelViewProj = mat4Multiply(projectionMatrix, mat4Multiply(viewMatrix, modelMatrix));

  globeApp.globeRenderer.drawFrame(
    { modelViewProj, modelMatrix, eyePosition },
    globeApp.baseSlot,
    globeApp.detailSlot,
    globeApp.landLayers.detailClip
  );
  const selectionMarkers = globeApp.pointSelection.currentMarkers();
  if (selectionMarkers) {
    globeApp.selectionOverlay.drawSelection(modelViewProj, orbitCamera.heightMeters, selectionMarkers.presentUnit, selectionMarkers.currentUnit);
  }
}

/**
 * Start the application and its frame loop.
 *
 * Usage: module entry (index.html loads this file).
 *
 * @returns Nothing.
 */
function startApplication(): void {
  const globeApp = createApplication();
  void globeApp.plateTracker.loadRotationModel();
  let lastFrameMs = performance.now();
  const frameLoop = () => {
    const nowMillis = performance.now();
    renderFrame(globeApp, (nowMillis - lastFrameMs) / 1000);
    lastFrameMs = nowMillis;
    requestAnimationFrame(frameLoop);
  };
  window.addEventListener("pagehide", (pageEvent) => {
    if (!pageEvent.persisted) globeApp.landLayers.disposeLayers();
  });
  requestAnimationFrame(frameLoop);
}

startApplication();
