/**
 * Timeline bar. By default it runs from the past (left, max Ma) to the present
 * (right, 0 Ma); the "Present → past" checkbox flips it so the present is on the
 * left and Play / → move into the past. The slider position is the distance
 * along the chosen direction, i.e. `maxAge - age` normally and `age` reversed.
 */

/** [older bound Ma, name] — ICS periods within the model's range. */
const PERIODS: [number, string][] = [
  [2.58, "Quaternary"],
  [23.03, "Neogene"],
  [66, "Paleogene"],
  [145, "Cretaceous"],
  [201.4, "Jurassic"],
  [251.9, "Triassic"],
  [298.9, "Permian"],
  [358.9, "Carboniferous"],
  [419.2, "Devonian"],
  [443.8, "Silurian"],
  [485.4, "Ordovician"],
  [538.8, "Cambrian"],
  [635, "Ediacaran"],
  [720, "Cryogenian"],
  [1000, "Tonian"],
  [1200, "Stenian"],
];

export function periodName(age: number): string {
  for (const [bound, name] of PERIODS) if (age <= bound) return name;
  return "";
}

export class Timeline {
  private slider = document.getElementById("tl-age") as HTMLInputElement;
  private readout = document.getElementById("tl-readout") as HTMLOutputElement;
  private playBtn = document.getElementById("tl-play") as HTMLButtonElement;
  private speedSel = document.getElementById("tl-speed") as HTMLSelectElement;
  private reverseBox = document.getElementById("tl-reverse") as HTMLInputElement;
  private startLabel = document.getElementById("tl-start") as HTMLSpanElement;
  private endLabel = document.getElementById("tl-end") as HTMLSpanElement;
  private statusEl = document.getElementById("tl-status") as HTMLSpanElement;

  private age = 0;
  private maxAge = 0;
  private playing = false;

  constructor(private onAge: (age: number) => void) {
    this.slider.addEventListener("input", () => {
      this.pause();
      this.set(this.ageAt(Number(this.slider.value)));
    });
    this.playBtn.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.reverseBox.addEventListener("change", () => this.layout());
    window.addEventListener("keydown", (e) => {
      if (!this.maxAge || e.target === this.slider || e.target instanceof HTMLSelectElement) return;
      const step = (e.shiftKey ? 10 : 1) * this.dir;
      if (e.key === "ArrowRight") this.set(this.age + step);
      else if (e.key === "ArrowLeft") this.set(this.age - step);
      else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        if (this.playing) this.pause();
        else this.play();
        return;
      } else return;
      this.pause();
    });
  }

  /** Present → past (checkbox ticked). */
  get reversed(): boolean {
    return this.reverseBox.checked;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentAge(): number {
    return this.age;
  }

  /** +1 when moving forward along the bar means older (reversed), −1 when younger. */
  private get dir(): number {
    return this.reversed ? 1 : -1;
  }

  private ageAt(pos: number): number {
    return this.reversed ? pos : this.maxAge - pos;
  }

  private posOf(age: number): number {
    return Math.round(this.reversed ? age : this.maxAge - age);
  }

  private layout() {
    const oldest = `${this.maxAge} Ma`;
    this.startLabel.textContent = this.reversed ? "Present" : oldest;
    this.endLabel.textContent = this.reversed ? oldest : "Present";
    this.slider.setAttribute(
      "aria-label",
      this.reversed ? "Timeline from the present (left) to the past (right)" : "Timeline from the past (left) to the present (right)"
    );
    this.slider.value = String(this.posOf(this.age));
  }

  /** Enable the controls once the rotation model is known. */
  enable(maxAge: number) {
    this.maxAge = maxAge;
    this.slider.max = String(maxAge);
    this.slider.disabled = false;
    this.playBtn.disabled = false;
    this.layout();
  }

  setStatus(text: string) {
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
  }

  set(age: number) {
    const a = Math.max(0, Math.min(this.maxAge, age));
    const pos = String(this.posOf(a));
    if (a === this.age && this.slider.value === pos) return;
    this.age = a;
    this.slider.value = pos;
    const period = periodName(a);
    this.readout.textContent = `${a.toFixed(0)} Ma${period ? ` · ${period}` : ""}`;
    this.onAge(a);
  }

  /** Play in the bar's direction; at the end it restarts from the beginning. */
  play() {
    if (!this.maxAge) return;
    const end = this.reversed ? this.maxAge : 0;
    if (this.age === end) this.set(this.reversed ? 0 : this.maxAge);
    this.playing = true;
    this.playBtn.textContent = "❚❚ Pause";
  }

  pause() {
    this.playing = false;
    this.playBtn.textContent = "▶ Play";
  }

  /** Advance playback; call once per animation frame. */
  tick(dtSec: number) {
    if (!this.playing) return;
    const speed = Number(this.speedSel.value) || 20;
    const next = this.age + this.dir * speed * Math.min(dtSec, 0.1);
    const end = this.reversed ? this.maxAge : 0;
    if (this.reversed ? next >= end : next <= end) {
      this.set(end);
      this.pause();
    } else {
      this.set(next);
    }
  }
}
