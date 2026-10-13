/**
 * Timeline bar: runs from the past (left, max Ma) to the present (right, 0 Ma).
 * The slider position is "time elapsed since max Ma", i.e. maxAge - age, so
 * dragging right and Play both move toward the present.
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
  private crustBox = document.getElementById("tl-crust") as HTMLInputElement;
  private maxLabel = document.getElementById("tl-max") as HTMLSpanElement;
  private statusEl = document.getElementById("tl-status") as HTMLSpanElement;

  private age = 0;
  private maxAge = 0;
  private playing = false;

  constructor(
    private onAge: (age: number) => void,
    private onCrust: (visible: boolean) => void
  ) {
    this.slider.addEventListener("input", () => {
      this.pause();
      this.set(this.maxAge - Number(this.slider.value));
    });
    this.playBtn.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    this.crustBox.addEventListener("change", () => this.onCrust(this.crustBox.checked));
    window.addEventListener("keydown", (e) => {
      if (!this.maxAge || e.target === this.slider) return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "ArrowRight") this.set(this.age - step); // toward the present
      else if (e.key === "ArrowLeft") this.set(this.age + step); // into the past
      else if (e.key === " " && e.target === document.body) {
        e.preventDefault();
        if (this.playing) this.pause();
        else this.play();
        return;
      } else return;
      this.pause();
    });
  }

  get crustVisible(): boolean {
    return this.crustBox.checked;
  }

  /** Enable the controls once the rotation model is known. */
  enable(maxAge: number) {
    this.maxAge = maxAge;
    this.slider.max = String(maxAge);
    this.slider.value = String(maxAge - this.age);
    this.maxLabel.textContent = `${maxAge} Ma`;
    this.slider.disabled = false;
    this.playBtn.disabled = false;
  }

  setStatus(text: string) {
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
  }

  set(age: number) {
    const a = Math.max(0, Math.min(this.maxAge, age));
    const pos = String(Math.round(this.maxAge - a));
    if (a === this.age && this.slider.value === pos) return;
    this.age = a;
    this.slider.value = pos;
    const period = periodName(a);
    this.readout.textContent = `${a.toFixed(0)} Ma${period ? ` · ${period}` : ""}`;
    this.onAge(a);
  }

  /** Play toward the present; from the present it restarts at the oldest age. */
  play() {
    if (!this.maxAge) return;
    if (this.age <= 0) this.set(this.maxAge);
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
    const next = this.age - speed * Math.min(dtSec, 0.1);
    if (next <= 0) {
      this.set(0);
      this.pause();
    } else {
      this.set(next);
    }
  }
}
