export const TEMPOS = Object.freeze({ slow: 36, normal: 50, fast: 65 });
export const DIFFICULTIES = Object.freeze({ beginner: 200, intermediate: 100, advanced: 30 });
export const MELODY = Object.freeze([
  { midi: 67, name: 'Соль', latin: 'G', beats: 0.5 },
  { midi: 70, name: 'Си', latin: 'B-flat', beats: 0.5 },
  { midi: 69, name: 'Ля', latin: 'A', beats: 0.5 },
  { midi: 62, name: 'Ре', latin: 'D', beats: 0.65 },
]);
export const midiToHz = midi => 440 * 2 ** ((midi - 69) / 12);
export const hzToMidi = hz => 69 + 12 * Math.log2(hz / 440);
export function centsFrom(frequency, midi, anyOctave = false) {
  if (!(frequency > 0) || !Number.isFinite(frequency)) return null;
  let cents = (hzToMidi(frequency) - midi) * 100;
  if (anyOctave) cents -= Math.round(cents / 1200) * 1200;
  return cents;
}
export function withinTolerance(cents, tolerance) {
  return cents !== null && Math.abs(cents) <= tolerance + 1e-6;
}
const noteNames = {
  en: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'],
  ru: ['До', 'До♯', 'Ре', 'Ми♭', 'Ми', 'Фа', 'Фа♯', 'Соль', 'Ля♭', 'Ля', 'Си♭', 'Си'],
};
export function noteName(midi, language = 'en') {
  const n = Math.round(midi);
  const name = (noteNames[language] ?? noteNames.en)[(n % 12 + 12) % 12];
  const octave = Math.floor(n / 12) - 1;
  return language === 'ru' ? `${name} ${octave}` : `${name}${octave}`;
}
export function sequence(octave = 5, bpm = TEMPOS.normal) {
  return MELODY.map(n => ({ ...n, midi: n.midi + (octave - 4) * 12, duration: n.beats * 60000 / bpm }));
}

// YIN cumulative mean normalized difference. No target-note bias is used.
export class PitchDetector {
  constructor() {
    this.samples = new Float32Array(4096);
    this.difference = new Float32Array(1024);
  }
  detect(input, sampleRate, noiseFloor = 0.006) {
    const step = sampleRate > 32000 ? 2 : 1;
    const size = Math.min(Math.floor(input.length / step), this.samples.length);
    const sr = sampleRate / step;
    let mean = 0;
    for (let i = 0; i < size; i++) { this.samples[i] = input[i * step]; mean += this.samples[i]; }
    mean /= size;
    let energy = 0;
    for (let i = 0; i < size; i++) { this.samples[i] -= mean; energy += this.samples[i] ** 2; }
    const rms = Math.sqrt(energy / size);
    if (rms < noiseFloor) return { frequency: null, rms, clarity: 0 };
    const minLag = Math.max(2, Math.floor(sr / 2500));
    const maxLag = Math.min(Math.ceil(sr / 180), Math.floor(size / 2) - 1, 1022);
    const window = Math.floor(size / 2);
    let running = 0;
    this.difference[0] = 1;
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      let sum = 0;
      for (let i = 0; i < window; i++) { const d = this.samples[i] - this.samples[i + lag]; sum += d * d; }
      running += sum;
      this.difference[lag] = running ? sum * lag / running : 1;
    }
    let candidate = -1;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (this.difference[lag] < 0.13) {
        while (lag < maxLag && this.difference[lag + 1] < this.difference[lag]) lag++;
        candidate = lag; break;
      }
    }
    if (candidate < 0) return { frequency: null, rms, clarity: 0 };
    const a = this.difference[candidate - 1], b = this.difference[candidate], c = this.difference[candidate + 1];
    const divisor = a - 2 * b + c;
    const offset = divisor ? Math.max(-1, Math.min(1, 0.5 * (a - c) / divisor)) : 0;
    const frequency = sr / (candidate + offset);
    return { frequency: frequency >= 180 && frequency <= 2500 ? frequency : null, rms, clarity: 1 - b };
  }
}

export class TrainingSession {
  constructor({ mode = 'steps', notes = sequence(), tolerance = 30, anyOctave = true, startTime = 0 } = {}) {
    Object.assign(this, { mode, notes, tolerance, anyOctave, startTime });
    this.lastTime = startTime;
    this.index = 0;
    this.hold = 0;
    this.holdPrecision = 0;
    this.gap = 0;
    this.transitionPitch = null;
    this.transitionSilence = 0;
    this.done = false;
    this.results = notes.map(() => null);
    this.earned = notes.map(() => 0);
    this.totalDuration = notes.reduce((s, n) => s + n.duration, 0);
    this.elapsed = 0;
  }
  tick(frequency, time) {
    if (this.done || time < this.startTime) return;
    const dt = Math.max(0, Math.min(100, time - this.lastTime));
    this.lastTime = time;
    this.elapsed = time - this.startTime;
    if (this.mode === 'free') return;
    if (this.mode === 'rhythm') {
      let boundary = 0;
      for (let i = 0; i < this.notes.length; i++) {
        const end = boundary + this.notes[i].duration;
        const overlap = Math.max(0, Math.min(this.elapsed, end) - Math.max(this.elapsed - dt, boundary));
        const cents = centsFrom(frequency, this.notes[i].midi, this.anyOctave);
        if (withinTolerance(cents, this.tolerance)) this.earned[i] += overlap * (1 - Math.abs(cents) / (2 * this.tolerance));
        if (this.elapsed >= end) this.results[i] = Math.round(100 * Math.min(1, this.earned[i] / this.notes[i].duration));
        if (this.elapsed >= boundary && this.elapsed < end) { this.index = i; this.hold = this.elapsed - boundary; }
        boundary = end;
      }
      if (this.elapsed >= this.totalDuration) {
        this.index = this.notes.length - 1;
        this.done = true;
      }
      return;
    }
    if (this.transitionPitch !== null) {
      // Overlapping pitch bands still require a new whistle or an audible pitch change.
      if (frequency) this.transitionSilence = 0;
      else this.transitionSilence += dt;
      const shift = centsFrom(frequency, this.transitionPitch);
      if ((shift === null || Math.abs(shift) < 55) && this.transitionSilence < 90) return;
      this.transitionPitch = null;
    }
    const cents = centsFrom(frequency, this.notes[this.index].midi, this.anyOctave);
    if (withinTolerance(cents, this.tolerance)) {
      this.gap = 0;
      this.hold += dt;
      this.holdPrecision += dt * (1 - Math.abs(cents) / (2 * this.tolerance));
    } else {
      this.gap += dt;
      if (this.gap > 100) { this.hold = 0; this.holdPrecision = 0; }
    }
    if (this.hold >= this.notes[this.index].duration) {
      this.results[this.index] = Math.round(100 * this.holdPrecision / this.hold);
      if (this.index === this.notes.length - 1) this.done = true;
      else {
        this.index++;
        this.hold = 0;
        this.holdPrecision = 0;
        this.gap = 0;
        const nextCents = centsFrom(frequency, this.notes[this.index].midi, this.anyOctave);
        if (withinTolerance(nextCents, this.tolerance)) {
          this.transitionPitch = hzToMidi(frequency);
          this.transitionSilence = 0;
        }
      }
    }
  }
  get score() { return Math.round(this.results.reduce((s, n) => s + (n || 0), 0) / this.notes.length); }
  get progress() {
    if (this.done) return 1;
    if (this.mode === 'rhythm') return Math.min(1, this.elapsed / this.totalDuration);
    return (this.notes.slice(0, this.index).reduce((s, n) => s + n.duration, 0) + this.hold) / this.totalDuration;
  }
}
