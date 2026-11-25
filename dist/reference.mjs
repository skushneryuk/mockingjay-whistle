const recordingUrl = new URL('./assets/recorded-whistle.wav', import.meta.url);
const recordingPitches = [1572, 1885, 1727, 1573];
const segmentLength = 1.5;

function envelope(duration, level, attack, release) {
  return Float32Array.from({ length: 64 }, (_, i) => {
    const time = i * duration / 63;
    const edge = Math.min(1, time / attack, (duration - time) / release);
    const fade = (1 - Math.cos(Math.PI * edge)) / 2;
    return level * (1 - 0.16 * time / duration) * fade;
  });
}

export class ReferenceAudio {
  constructor(context) {
    this.context = context;
    this.master = context.createGain();
    this.master.connect(context.destination);
    this.voices = new Set();
    this.wave = context.createPeriodicWave(
      new Float32Array([0, 0, 0]),
      new Float32Array([0, 1, 0.025]),
    );
  }

  setVolume(volume) {
    this.master.gain.setTargetAtTime((volume / 100) ** 1.4, this.context.currentTime, 0.018);
  }

  async prepare(kind) {
    if (kind !== 'recording' || this.recording) return;
    try {
      this.loading ??= fetch(recordingUrl).then(response => {
        if (!response.ok) throw new Error();
        return response.arrayBuffer();
      }).then(bytes => this.context.decodeAudioData(bytes));
      this.recording = await this.loading;
    } catch {
      this.loading = null;
      throw new Error('unavailableRecording');
    }
  }

  addVoice(node, start, duration, level, attack, release, offset) {
    const shape = this.context.createGain();
    const cutoff = this.context.createGain();
    shape.gain.value = 0;
    shape.gain.setValueCurveAtTime(envelope(duration, level, attack, release), start, duration);
    node.connect(shape).connect(cutoff).connect(this.master);
    const voice = { node, cutoff, start };
    this.voices.add(voice);
    node.onended = () => {
      this.voices.delete(voice);
      node.disconnect();
      shape.disconnect();
      cutoff.disconnect();
    };
    if (offset === undefined) node.start(start);
    else node.start(start, offset);
    node.stop(start + duration);
  }

  play(kind, index, frequency, start, slotDuration) {
    const duration = slotDuration * 0.94;
    const attenuation = Math.min(1, (780 / frequency) ** 0.38);
    if (kind === 'recording') {
      const node = this.context.createBufferSource();
      node.buffer = this.recording;
      node.playbackRate.value = frequency / recordingPitches[index];
      this.addVoice(node, start, duration, 0.92 * attenuation, 0.055, 0.10, index * segmentLength);
      return;
    }
    const node = this.context.createOscillator();
    node.setPeriodicWave(this.wave);
    node.frequency.value = frequency;
    node.detune.setValueAtTime(-13, start);
    node.detune.linearRampToValueAtTime(1, start + 0.085);
    node.detune.linearRampToValueAtTime(-3, start + duration);
    this.addVoice(node, start, duration, 0.135 * attenuation, 0.072, 0.12);
  }

  countIn(frequency, start) {
    const node = this.context.createOscillator();
    node.frequency.value = frequency;
    this.addVoice(node, start, 0.098, 0.085, 0.017, 0.055);
  }

  stop() {
    const now = this.context.currentTime;
    for (const { node, cutoff, start } of this.voices) {
      if (start > now) {
        node.stop(now);
      } else {
        cutoff.gain.setValueAtTime(1, now);
        cutoff.gain.linearRampToValueAtTime(0, now + 0.026);
        node.stop(now + 0.029);
      }
    }
    this.voices.clear();
  }
}
