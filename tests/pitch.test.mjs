import test from 'node:test';
import assert from 'node:assert/strict';
import { PitchDetector, TrainingSession, sequence, midiToHz, hzToMidi, centsFrom } from '../dist/pitch.mjs';

function signal(frequency, sampleRate = 48000, { amplitude = 0.15, noise = 0, harmonic = 0 } = {}) {
  let seed = 42;
  return Float32Array.from({ length: 2048 }, (_, i) => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return amplitude * (Math.sin(2 * Math.PI * frequency * i / sampleRate) + harmonic * Math.sin(4 * Math.PI * frequency * i / sampleRate)) + noise * (seed / 0xffffffff - 0.5);
  });
}
for (const rate of [44100, 48000, 96000]) {
  test(`Detects every reference note in three octaves at ${rate} Hz`, () => {
    const detector = new PitchDetector();
    for (const octave of [4, 5, 6]) for (const note of sequence(octave)) {
      const expected = midiToHz(note.midi);
      const result = detector.detect(signal(expected, rate), rate);
      assert.ok(result.frequency, `No pitch for ${expected}`);
      const cents = Math.abs(1200 * Math.log2(result.frequency / expected));
      assert.ok(cents < 12, `Pitch error ${cents} cents for ${expected}`);
    }
  });
}
test('Rejects silence, DC offset and broadband noise', () => {
  const detector = new PitchDetector();
  for (const input of [new Float32Array(2048), new Float32Array(2048).fill(0.2), signal(0, 48000, { amplitude: 0, noise: 0.2 })]) assert.equal(detector.detect(input, 48000).frequency, null);
});
test('Finds the fundamental with harmonics and moderate noise', () => {
  const detector = new PitchDetector();
  for (const hz of [293.665, 440, 784, 932.33, 1760]) {
    const result = detector.detect(signal(hz, 48000, { noise: 0.03, harmonic: 0.35 }), 48000);
    assert.ok(result.frequency && Math.abs(1200 * Math.log2(result.frequency / hz)) < 15);
  }
});
test('Tuning math and octave tolerance', () => {
  assert.equal(midiToHz(69), 440); assert.equal(hzToMidi(440), 69);
  assert.ok(Math.abs(centsFrom(880, 69, true)) < 0.001);
  assert.equal(centsFrom(880, 69, false), 1200);
  assert.equal(centsFrom(null, 69), null);
  assert.equal(centsFrom(Infinity, 69), null);
});
test('Reference intervals and rhythmic proportions remain unchanged when transposed', () => {
  const notes = sequence(5, 120);
  assert.deepEqual(notes.map(n => n.midi), [79, 82, 81, 74]);
  assert.deepEqual(notes.map(n => n.duration), [250, 250, 250, 1000]);
});
test('Steps reject wrong pitches and reset an interrupted hold', () => {
  const session = new TrainingSession({ notes: sequence(4, 120) });
  let time = 0;
  for (let i = 0; i < 15; i++) session.tick(440, time += 30);
  assert.equal(session.index, 0); assert.equal(session.hold, 0);
  for (let i = 0; i < 5; i++) session.tick(midiToHz(67), time += 30);
  assert.equal(session.hold, 150);
  for (let i = 0; i < 5; i++) session.tick(null, time += 30);
  assert.equal(session.hold, 0);
});
test('Steps and echo require all four notes, including the long final hold', () => {
  for (const mode of ['steps', 'echo']) {
    const session = new TrainingSession({ mode, notes: sequence(5, 120) });
    let time = 0;
    while (session.index < 3) session.tick(midiToHz(session.notes[session.index].midi), time += 25);
    for (let i = 0; i < 10; i++) session.tick(midiToHz(74), time += 25);
    assert.equal(session.done, false);
    for (let i = 0; i < 30; i++) session.tick(midiToHz(74), time += 25);
    assert.equal(session.done, true); assert.equal(session.score, 100);
  }
});
test('Octave matching is optional in scoring', () => {
  for (const anyOctave of [true, false]) {
    const session = new TrainingSession({ notes: sequence(4, 120), anyOctave });
    for (let t = 25; t <= 300; t += 25) session.tick(midiToHz(79), t);
    assert.equal(session.index, anyOctave ? 1 : 0);
  }
});
test('Rhythm silence is scored zero, correct timing scores 100', () => {
  for (const silent of [true, false]) {
    const session = new TrainingSession({ mode: 'rhythm', notes: sequence(4, 120), startTime: 500 });
    session.tick(392, 400); assert.equal(session.elapsed, 0);
    for (let t = 525; t <= 2250; t += 25) {
      const relative = t - 500 - 1;
      const index = relative < 250 ? 0 : relative < 500 ? 1 : relative < 750 ? 2 : 3;
      session.tick(silent ? null : midiToHz(session.notes[index].midi), t);
    }
    assert.equal(session.done, true); assert.equal(session.score, silent ? 0 : 100);
  }
});
test('A long scheduler gap cannot invent a successfully held note', () => {
  const session = new TrainingSession({ notes: sequence(4, 120) });
  session.tick(midiToHz(67), 5000);
  assert.equal(session.index, 0); assert.equal(session.hold, 100);
});
