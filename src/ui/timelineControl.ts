/**
 * Timeline bar. By default it runs from the past (left, max Ma) to the present
 * (right, 0 Ma); the "Present → past" checkbox flips it so the present is on the
 * left and Play / → move into the past. The slider position is the distance
 * along the chosen direction, i.e. `maxAge - age` normally and `age` reversed.
 */

import { clampValue } from "../geodesy/angleMath";
import { periodName } from "../plates/geologicPeriods";

export type TimelineElements = {
  ageSlider: HTMLInputElement;
  ageReadout: HTMLOutputElement;
  playButton: HTMLButtonElement;
  speedSelect: HTMLSelectElement;
  reverseCheckbox: HTMLInputElement;
  startLabel: HTMLElement;
  endLabel: HTMLElement;
  statusElement: HTMLElement;
};

/** Read-only view of the timeline used by the land and plate logic. */
export interface AgeSource {
  readonly currentAgeMa: number;
  readonly isPlaying: boolean;
}

const DEFAULT_SPEED_MYR_PER_S = 20;
const MAX_TICK_SECONDS = 0.1;
const SHIFT_STEP_MYR = 10;

export class TimelineControl implements AgeSource {
  private ageInMyr = 0;
  private maxAgeMa = 0;
  private isRunning = false;

  /**
   * Bind the controls and keyboard shortcuts (←/→ step, Shift ×10, Space play/pause).
   *
   * Usage: once at start-up; the controls stay disabled until enableControls().
   *
   * @param timelineElements - The timeline's DOM elements.
   * @param onAgeChange - Called whenever the age changes.
   */
  constructor(
    private readonly timelineElements: TimelineElements,
    private readonly onAgeChange: (ageInMyr: number) => void
  ) {
    timelineElements.ageSlider.addEventListener("input", () => {
      this.pausePlayback();
      this.setCurrentAge(this.ageAtSlider(Number(timelineElements.ageSlider.value)));
    });
    timelineElements.playButton.addEventListener("click", () => (this.isRunning ? this.pausePlayback() : this.startPlayback()));
    timelineElements.reverseCheckbox.addEventListener("change", () => this.layoutLabels());
    window.addEventListener("keydown", (keyEvent) => this.handleKey(keyEvent));
  }

  /**
   * Keyboard shortcuts.
   *
   * Usage: window keydown handler.
   *
   * @param keyEvent - Key event.
   * @returns Nothing.
   */
  private handleKey(keyEvent: KeyboardEvent): void {
    if (!this.maxAgeMa || keyEvent.target === this.timelineElements.ageSlider || keyEvent.target instanceof HTMLSelectElement) return;
    const stepSizeMyr = (keyEvent.shiftKey ? SHIFT_STEP_MYR : 1) * this.direction;
    if (keyEvent.key === "ArrowRight") this.setCurrentAge(this.ageInMyr + stepSizeMyr);
    else if (keyEvent.key === "ArrowLeft") this.setCurrentAge(this.ageInMyr - stepSizeMyr);
    else if (keyEvent.key === " " && keyEvent.target === document.body) {
      keyEvent.preventDefault();
      if (this.isRunning) this.pausePlayback();
      else this.startPlayback();
      return;
    } else return;
    this.pausePlayback();
  }

  /**
   * Whether the bar runs present → past (checkbox ticked).
   *
   * Usage: direction-dependent mapping.
   *
   * @returns True when reversed.
   */
  get isReversed(): boolean {
    return this.timelineElements.reverseCheckbox.checked;
  }

  /**
   * Whether playback is running.
   *
   * Usage: detail loading pauses during playback.
   *
   * @returns True while playing.
   */
  get isPlaying(): boolean {
    return this.isRunning;
  }

  /**
   * The displayed age.
   *
   * Usage: single source of truth for the current age.
   *
   * @returns Age in Ma.
   */
  get currentAgeMa(): number {
    return this.ageInMyr;
  }

  /**
   * Age change per step forward along the bar: +1 (older) when reversed, −1 otherwise.
   *
   * Usage: keys and playback.
   *
   * @returns ±1.
   */
  private get direction(): number {
    return this.isReversed ? 1 : -1;
  }

  /**
   * Age at a slider position.
   *
   * Usage: slider input.
   *
   * @param sliderPos - Slider value.
   * @returns Age in Ma.
   */
  private ageAtSlider(sliderPos: number): number {
    return this.isReversed ? sliderPos : this.maxAgeMa - sliderPos;
  }

  /**
   * Slider position of an age.
   *
   * Usage: keep the slider in sync.
   *
   * @param ageInMyr - Age in Ma.
   * @returns Rounded slider value.
   */
  private sliderPosOf(ageInMyr: number): number {
    return Math.round(this.isReversed ? ageInMyr : this.maxAgeMa - ageInMyr);
  }

  /**
   * Update end labels, aria label and slider position for the current direction.
   *
   * Usage: enableControls() and direction changes.
   *
   * @returns Nothing.
   */
  private layoutLabels(): void {
    const oldestLabel = `${this.maxAgeMa} Ma`;
    const elements = this.timelineElements;
    elements.startLabel.textContent = this.isReversed ? "Present" : oldestLabel;
    elements.endLabel.textContent = this.isReversed ? oldestLabel : "Present";
    elements.ageSlider.setAttribute(
      "aria-label",
      this.isReversed
        ? "Timeline from the present (left) to the past (right)"
        : "Timeline from the past (left) to the present (right)"
    );
    elements.ageSlider.value = String(this.sliderPosOf(this.ageInMyr));
  }

  /**
   * Enable the controls once the rotation model is known.
   *
   * Usage: after /api/rotations loaded.
   *
   * @param maxAgeMa - Oldest age of the model.
   * @returns Nothing.
   */
  enableControls(maxAgeMa: number): void {
    this.maxAgeMa = maxAgeMa;
    this.timelineElements.ageSlider.max = String(maxAgeMa);
    this.timelineElements.ageSlider.disabled = false;
    this.timelineElements.playButton.disabled = false;
    this.layoutLabels();
  }

  /**
   * Show a status note next to the options.
   *
   * Usage: plate-layer and detail status.
   *
   * @param statusText - Text ("" hides it).
   * @returns Nothing.
   */
  setStatus(statusText: string): void {
    if (this.timelineElements.statusElement.textContent !== statusText) this.timelineElements.statusElement.textContent = statusText;
  }

  /**
   * Set the displayed age (clamped), update the read-out and notify.
   *
   * Usage: slider, keys and playback.
   *
   * @param requestedAge - Age in Ma.
   * @returns Nothing.
   */
  setCurrentAge(requestedAge: number): void {
    const clampedAge = clampValue(requestedAge, 0, this.maxAgeMa);
    const sliderValue = String(this.sliderPosOf(clampedAge));
    if (clampedAge === this.ageInMyr && this.timelineElements.ageSlider.value === sliderValue) return;
    this.ageInMyr = clampedAge;
    this.timelineElements.ageSlider.value = sliderValue;
    const periodText = periodName(clampedAge);
    this.timelineElements.ageReadout.textContent = `${clampedAge.toFixed(0)} Ma${periodText ? ` · ${periodText}` : ""}`;
    this.onAgeChange(clampedAge);
  }

  /**
   * Play in the bar's direction; at the end it restarts from the beginning.
   *
   * Usage: Play button and Space.
   *
   * @returns Nothing.
   */
  startPlayback(): void {
    if (!this.maxAgeMa) return;
    const finalAgeMyr = this.isReversed ? this.maxAgeMa : 0;
    if (this.ageInMyr === finalAgeMyr) this.setCurrentAge(this.isReversed ? 0 : this.maxAgeMa);
    this.isRunning = true;
    this.timelineElements.playButton.textContent = "❚❚ Pause";
  }

  /**
   * Stop playback.
   *
   * Usage: Pause button, slider and keys.
   *
   * @returns Nothing.
   */
  pausePlayback(): void {
    this.isRunning = false;
    this.timelineElements.playButton.textContent = "▶ Play";
  }

  /**
   * Advance playback.
   *
   * Usage: once per animation frame.
   *
   * @param deltaSeconds - Time since the previous frame (capped at 0.1 s).
   * @returns Nothing.
   */
  advanceFrame(deltaSeconds: number): void {
    if (!this.isRunning) return;
    const speedMyrPerS = Number(this.timelineElements.speedSelect.value) || DEFAULT_SPEED_MYR_PER_S;
    const nextAgeMyr = this.ageInMyr + this.direction * speedMyrPerS * Math.min(deltaSeconds, MAX_TICK_SECONDS);
    const finalAgeMyr = this.isReversed ? this.maxAgeMa : 0;
    if (this.isReversed ? nextAgeMyr >= finalAgeMyr : nextAgeMyr <= finalAgeMyr) {
      this.setCurrentAge(finalAgeMyr);
      this.pausePlayback();
    } else {
      this.setCurrentAge(nextAgeMyr);
    }
  }
}
