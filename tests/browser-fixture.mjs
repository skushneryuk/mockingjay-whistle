// Local-only QA: a real Web Audio oscillator feeds a MediaStream, with no hardware microphone.
// This file and the /_qa.html route are not included in the deployed static directory.
import { sequence, midiToHz } from '/pitch.mjs';
// Keep test scores separate from the user's local practice history.
for (const method of ['getItem', 'setItem', 'removeItem']) {
  const original = Storage.prototype[method];
  Storage.prototype[method] = function(key, ...args) { return original.call(this, 'qa-' + key, ...args); };
}
const panel = document.createElement('section');
panel.style.cssText = 'position:relative;padding:14px;background:#fff0c9;color:#2d2118;border-bottom:2px solid #ab792b;z-index:5;font:14px sans-serif;display:flex;flex-wrap:wrap;gap:12px;align-items:center';
panel.innerHTML = '<strong>QA · синтетический микрофон</strong><label>Сценарий <select id="qa-scenario"><option value="melody">Верная мелодия</option><option value="silence">Тишина</option><option value="denied">Отказ в доступе</option><option value="pending">Отложенный доступ</option></select></label><button id="qa-resolve">Выдать отложенный поток</button><output id="qa-tracks">Живых дорожек: 0</output><output id="qa-audio"></output>';
document.body.prepend(panel);
const tracks = [], contexts = [];
let resolvePending;
const diagnostics = [];
let inputPeak = 0, inputReads = 0, generatedPeak = 0;
const originalRead = AnalyserNode.prototype.getFloatTimeDomainData;
AnalyserNode.prototype.getFloatTimeDomainData = function(array) {
  originalRead.call(this, array);
  const rms = Math.sqrt(array.reduce((s, n) => s + n * n, 0) / array.length);
  if (diagnostics.some(d => d.analyser === this)) generatedPeak = Math.max(generatedPeak, rms);
  else { inputPeak = Math.max(inputPeak, rms); inputReads++; }
};
function update() {
  document.getElementById('qa-tracks').textContent = 'Живых дорожек: ' + tracks.filter(t => t.readyState === 'live').length;
  document.getElementById('qa-audio').textContent = diagnostics.map(({context, analyser, buffer, oscillator}) => {
    analyser.getFloatTimeDomainData(buffer);
    const rms = Math.sqrt(buffer.reduce((s, n) => s + n * n, 0) / buffer.length);
    return `${context.state} · ${context.currentTime.toFixed(2)} с · ${context.sampleRate} Hz · RMS ${rms.toFixed(3)} · ${Math.round(oscillator.frequency.value)} Hz`;
  }).join(' / ') + ` · Generated peak ${generatedPeak.toFixed(3)} · Input peak ${inputPeak.toFixed(3)} · Reads ${inputReads}`;
}
async function makeStream(scenario) {
  const context = new AudioContext(); contexts.push(context); await context.resume();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator(), gain = context.createGain();
  oscillator.connect(gain).connect(destination); gain.gain.value = scenario === 'silence' ? 0 : 0.16;
  const monitor = context.createAnalyser(), muted = context.createGain(); muted.gain.value = 0;
  gain.connect(monitor).connect(muted).connect(context.destination);
  diagnostics.push({context, analyser:monitor, buffer:new Float32Array(monitor.fftSize), oscillator});
  const mode = document.querySelector('[data-mode][aria-pressed="true"]').dataset.mode;
  const bpm = +document.querySelector('[data-bpm][aria-pressed="true"]').dataset.bpm;
  const notes = sequence(+document.getElementById('octave').value, bpm), beat = 60 / bpm;
  const phrase = notes.reduce((seconds, note) => seconds + note.duration / 1000, 0);
  let start = context.currentTime + (mode === 'rhythm' ? 3 * beat + 0.15 : mode === 'echo' ? phrase + 2 * beat + 0.53 : 0.15);
  oscillator.frequency.setValueAtTime(440, context.currentTime);
  gain.gain.setValueAtTime(0, context.currentTime);
  gain.gain.setValueAtTime(scenario === 'silence' ? 0 : 0.16, start);
  for (const note of notes) { oscillator.frequency.setValueAtTime(midiToHz(note.midi), start); start += note.duration / 1000 + (mode === 'rhythm' ? 0 : 0.25); }
  oscillator.start(); oscillator.stop(start + 2);
  tracks.push(...destination.stream.getTracks()); update();
  return destination.stream;
}
navigator.mediaDevices.getUserMedia = async () => {
  const scenario = document.getElementById('qa-scenario').value;
  if (scenario === 'denied') throw new DOMException('Synthetic permission denied', 'NotAllowedError');
  if (scenario === 'pending') return new Promise(resolve => { resolvePending = resolve; });
  return makeStream(scenario);
};
document.getElementById('qa-resolve').addEventListener('click', async () => { if (resolvePending) { const resolve = resolvePending; resolvePending = null; resolve(await makeStream('silence')); } });
setInterval(update, 150);
window.addEventListener('pagehide', () => { tracks.forEach(t => t.stop()); contexts.forEach(c => c.close()); });
