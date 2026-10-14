/**
 * Small chart of the geomagnetic field strength through time: every PINT site's dipole
 * moment against age (log scale), a running median, and a marker at the displayed age
 * with the window's mean moment. Drawn on a canvas (no HTML from data).
 */

const MIN_AGE_MA = 0.01;
const MAX_AGE_MA = 5000;
const MAX_MOMENT_E22 = 25;
const MEDIAN_BINS = 60;
const MIN_BIN_SITES = 3;
const PLOT_PADDING_PX = 4;
const AXIS_TICK_AGES = [0.1, 1, 10, 100, 1000];
const DOT_COLOR = "rgba(154, 164, 178, 0.35)";
const MEDIAN_COLOR = "#7dd3a7";
const MARKER_COLOR = "#e0b872";
const LABEL_COLOR = "#9aa4b2";

/** Chart geometry in CSS pixels. */
type ChartBox = { plotWidth: number; plotHeight: number };

export class FieldStrengthChart {
  private siteAges: ArrayLike<number> & Iterable<number> = new Float64Array(0);
  private siteMoments: ArrayLike<number> = new Float64Array(0);
  private medianPoints: [number, number][] = [];

  /**
   * Bind the chart to its canvas.
   *
   * Usage: once at start-up with ``#pm-strength-chart``.
   *
   * @param canvasElement - Canvas to draw on (hidden until sites arrive).
   */
  constructor(private readonly canvasElement: HTMLCanvasElement) {
    canvasElement.hidden = true;
  }

  /**
   * Horizontal position of an age.
   *
   * Usage: every point drawn.
   *
   * @param ageInMyr - Age in Ma.
   * @param chartBox - Chart size.
   * @returns x in CSS pixels (log scale between MIN_AGE_MA and MAX_AGE_MA).
   */
  private ageToPixelX(ageInMyr: number, chartBox: ChartBox): number {
    const logFraction = (Math.log10(Math.max(MIN_AGE_MA, ageInMyr)) - Math.log10(MIN_AGE_MA)) / (Math.log10(MAX_AGE_MA) - Math.log10(MIN_AGE_MA));
    return PLOT_PADDING_PX + logFraction * (chartBox.plotWidth - 2 * PLOT_PADDING_PX);
  }

  /**
   * Vertical position of a moment.
   *
   * Usage: every point drawn.
   *
   * @param momentE22 - Moment in 10²² A·m².
   * @param chartBox - Chart size.
   * @returns y in CSS pixels (0 at the bottom).
   */
  private momentToY(momentE22: number, chartBox: ChartBox): number {
    return chartBox.plotHeight - PLOT_PADDING_PX - (Math.min(momentE22, MAX_MOMENT_E22) / MAX_MOMENT_E22) * (chartBox.plotHeight - 2 * PLOT_PADDING_PX);
  }

  /**
   * Running median of the moments in log-age bins.
   *
   * Usage: setSites.
   *
   * @returns [age, median] per bin with enough sites.
   */
  private computeMedians(): [number, number][] {
    const binMoments: number[][] = Array.from({ length: MEDIAN_BINS }, () => []);
    const logAgeSpan = Math.log10(MAX_AGE_MA) - Math.log10(MIN_AGE_MA);
    Array.from(this.siteAges).forEach((siteAgeMa, siteIndex) => {
      const siteMoment = this.siteMoments[siteIndex];
      if (!Number.isFinite(siteMoment)) return;
      const binIndex = Math.floor(((Math.log10(Math.max(MIN_AGE_MA, siteAgeMa)) - Math.log10(MIN_AGE_MA)) / logAgeSpan) * MEDIAN_BINS);
      binMoments[Math.min(MEDIAN_BINS - 1, Math.max(0, binIndex))].push(siteMoment);
    });
    return binMoments.flatMap((momentList, binIndex): [number, number][] => {
      if (momentList.length < MIN_BIN_SITES) return [];
      momentList.sort((firstMoment, secondMoment) => firstMoment - secondMoment);
      return [[10 ** (Math.log10(MIN_AGE_MA) + ((binIndex + 0.5) / MEDIAN_BINS) * logAgeSpan), momentList[Math.floor(momentList.length / 2)]]];
    });
  }

  /**
   * Set the plotted sites.
   *
   * Usage: when the paleomagnetic data arrived.
   *
   * @param siteAges - Site ages (Ma).
   * @param siteMoments - Dipole moments (10²² A·m²; NaN = unknown, not plotted).
   * @returns Nothing.
   */
  setSites(siteAges: ArrayLike<number> & Iterable<number>, siteMoments: ArrayLike<number>): void {
    this.siteAges = siteAges;
    this.siteMoments = siteMoments;
    this.medianPoints = this.computeMedians();
    this.canvasElement.hidden = false;
  }

  /**
   * Size the canvas for the device pixel ratio.
   *
   * Usage: markCurrentAge.
   *
   * @returns The drawing context (scaled to CSS pixels) and the chart size, or null without one.
   */
  private prepareCanvas(): { drawContext: CanvasRenderingContext2D; chartBox: ChartBox } | null {
    const drawContext = this.canvasElement.getContext("2d");
    if (!drawContext) return null;
    const chartBox = { plotWidth: this.canvasElement.clientWidth || 260, plotHeight: this.canvasElement.clientHeight || 70 };
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvasElement.width = Math.round(chartBox.plotWidth * pixelRatio);
    this.canvasElement.height = Math.round(chartBox.plotHeight * pixelRatio);
    drawContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawContext.clearRect(0, 0, chartBox.plotWidth, chartBox.plotHeight);
    return { drawContext, chartBox };
  }

  /**
   * Draw the sites, the median and the age ticks.
   *
   * Usage: markCurrentAge.
   *
   * @param drawContext - Context.
   * @param chartBox - Chart size.
   * @returns Nothing.
   */
  private drawBackground(drawContext: CanvasRenderingContext2D, chartBox: ChartBox): void {
    drawContext.fillStyle = DOT_COLOR;
    Array.from(this.siteAges).forEach((siteAgeMa, siteIndex) => {
      const siteMoment = this.siteMoments[siteIndex];
      if (Number.isFinite(siteMoment)) drawContext.fillRect(this.ageToPixelX(siteAgeMa, chartBox) - 0.5, this.momentToY(siteMoment, chartBox) - 0.5, 1.2, 1.2);
    });
    drawContext.strokeStyle = MEDIAN_COLOR;
    drawContext.lineWidth = 1.5;
    drawContext.beginPath();
    this.medianPoints.forEach(([medianAge, medianMoment], pointIndex) => {
      const pixelPosX = this.ageToPixelX(medianAge, chartBox);
      const pixelPosY = this.momentToY(medianMoment, chartBox);
      if (pointIndex === 0) drawContext.moveTo(pixelPosX, pixelPosY);
      else drawContext.lineTo(pixelPosX, pixelPosY);
    });
    drawContext.stroke();
    drawContext.fillStyle = LABEL_COLOR;
    drawContext.font = "9px system-ui, sans-serif";
    for (const tickAgeMa of AXIS_TICK_AGES) drawContext.fillText(`${tickAgeMa}`, this.ageToPixelX(tickAgeMa, chartBox) + 1, chartBox.plotHeight - 1);
  }

  /**
   * Redraw with a marker at the displayed age.
   *
   * Usage: whenever the displayed age changes.
   *
   * @param ageInMyr - Displayed age.
   * @param windowMomentE22 - Mean moment of the sites around it (NaN = none).
   * @returns Nothing.
   */
  markCurrentAge(ageInMyr: number, windowMomentE22: number): void {
    if (this.canvasElement.hidden) return;
    const preparedCanvas = this.prepareCanvas();
    if (!preparedCanvas) return;
    const { drawContext, chartBox } = preparedCanvas;
    this.drawBackground(drawContext, chartBox);
    const markerPosX = this.ageToPixelX(ageInMyr, chartBox);
    drawContext.strokeStyle = MARKER_COLOR;
    drawContext.lineWidth = 1;
    drawContext.beginPath();
    drawContext.moveTo(markerPosX, 0);
    drawContext.lineTo(markerPosX, chartBox.plotHeight);
    drawContext.stroke();
    if (Number.isFinite(windowMomentE22)) {
      drawContext.fillStyle = MARKER_COLOR;
      drawContext.beginPath();
      drawContext.arc(markerPosX, this.momentToY(windowMomentE22, chartBox), 3, 0, 2 * Math.PI);
      drawContext.fill();
    }
  }
}
