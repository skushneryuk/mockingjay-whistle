import { DIFFICULTIES, TEMPOS, PitchDetector, TrainingSession, sequence, midiToHz, hzToMidi, noteName, centsFrom, withinTolerance } from './pitch.mjs';
import { ReferenceAudio } from './reference.mjs';
import { PitchChart } from './chart.mjs';
import { copy } from './language.mjs';

const $ = id => document.getElementById(id);
const all = selector => document.querySelectorAll(selector);
const modes = ['steps', 'echo', 'rhythm', 'free'];
const pages = ['practice', 'progress', 'guide'];
const SETTINGS_KEY = 'mockingjay-settings';
const HISTORY_KEY = 'mockingjay-history';
const defaults = {
  language: 'en', mode: 'steps', bpm: TEMPOS.normal, difficulty: 'beginner',
  chart: 'follow', audioSource: 'recording', octave: 5, anyOctave: true, sensitivity: 0.006, volume: 55,
};
const settings = loadSettings();
let history = loadHistory();
const t = key => copy[settings.language][key];
const tolerance = () => DIFFICULTIES[settings.difficulty];
const locale = () => settings.language === 'ru' ? 'ru-RU' : 'en-US';

const canvas = $('pitch-canvas');
const chart = new PitchChart(canvas);
const detector = new PitchDetector();
const settingsPanel = $('settings-panel');
const settingsHome = settingsPanel.parentElement;
const settingsDialog = $('settings-dialog');
const compactLayout = matchMedia('(max-width: 900px), (pointer: coarse) and (max-width: 1100px)');
let notes = sequence(settings.octave, settings.bpm);
const indices = notes.map((_, i) => i);

let audio = null, reference = null, stream = null, micSource = null, analyser = null, silentOutput = null, buffer = null;
let phase = 'idle', session = null, lastSession = null, playback = null, generation = 0;
let lastFrequency = null, lastRms = 0, recentPitch = [], points = [], traceStart = null, needsDraw = true;
let noticeKey = '', noticeIsError = false, clearTimer = null;

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function saveLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function loadSettings() {
  const saved = readLocal(SETTINGS_KEY, {});
  const next = { ...defaults };
  const allowed = {
    language: Object.keys(copy), mode: modes, chart: ['follow', 'live'], audioSource: ['recording', 'synth'],
    bpm: Object.values(TEMPOS), difficulty: Object.keys(DIFFICULTIES), octave: [4, 5, 6],
    sensitivity: [0.003, 0.006, 0.018],
  };
  // Translate the old preset values to their new tempos and difficulty levels.
  const oldTempos = { 60: TEMPOS.slow, 90: TEMPOS.normal, 120: TEMPOS.fast };
  const oldTolerance = { 50: 'beginner', 30: 'intermediate', 15: 'advanced' };
  const migrated = { ...saved, bpm: oldTempos[saved.bpm] ?? saved.bpm, difficulty: saved.difficulty ?? oldTolerance[saved.tolerance] };
  for (const [key, options] of Object.entries(allowed)) {
    if (options.includes(migrated[key])) next[key] = migrated[key];
  }
  if (typeof saved.anyOctave === 'boolean') next.anyOctave = saved.anyOctave;
  if (Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100) next.volume = saved.volume;
  return next;
}

function loadHistory() {
  const saved = readLocal(HISTORY_KEY, []);
  if (!Array.isArray(saved)) return [];
  return saved.filter(entry => entry && modes.includes(entry.mode) && entry.mode !== 'free'
    && Number.isFinite(Date.parse(entry.date)) && Number.isFinite(entry.bpm)
    && Number.isFinite(entry.tolerance) && Number.isFinite(entry.octave)
    && Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 100).slice(0, 50);
}

function setText(el, value) {
  if (el.textContent !== String(value)) el.textContent = value;
}

function press(selector, active) {
  for (const element of all(selector)) element.setAttribute('aria-pressed', String(active(element)));
}

function localizedFrequency(hz) {
  return hz ? `${Math.round(hz)} ${t('hz')}` : '—';
}

function formatTolerance(cents) {
  const semitones = cents / 100;
  return Number.isInteger(semitones) ? `±${semitones} ${t('semitones')(semitones)}` : `±${cents} ${t('cents')}`;
}

function setNotice(key = '', error = false) {
  noticeKey = key;
  noticeIsError = error;
  renderNotice();
}

function renderNotice() {
  $('notice').hidden = !noticeKey;
  $('notice').classList.toggle('error', noticeIsError);
  setText($('notice'), noticeKey ? t(noticeKey) : '');
}

function localize() {
  document.documentElement.lang = settings.language;
  document.title = t('title');
  for (const el of all('[data-copy]')) setText(el, t(el.dataset.copy));
  for (const el of all('[data-label]')) el.setAttribute('aria-label', t(el.dataset.label));
  press('[data-language]', el => el.dataset.language === settings.language);
  renderSettings();
  renderNotice();
  renderHistory();
}

function renderSettings() {
  notes = sequence(settings.octave, settings.bpm);
  press('[data-mode]', el => el.dataset.mode === settings.mode);
  press('[data-bpm]', el => Number(el.dataset.bpm) === settings.bpm);
  press('[data-source]', el => el.dataset.source === settings.audioSource);
  $('difficulty').value = settings.difficulty;
  $('octave').value = settings.octave;
  $('any-octave').checked = settings.anyOctave;
  $('sensitivity').value = settings.sensitivity;
  $('volume').value = settings.volume;
  setText($('volume-value'), `${settings.volume}%`);
  setText($('tolerance-label'), formatTolerance(tolerance()));
  renderChartMode();
  renderNotes();
  refresh();
}

function liveChart() {
  return settings.mode === 'free' || settings.chart === 'live';
}

function renderChartMode() {
  press('[data-chart]', el => el.dataset.chart === settings.chart);
  $('chart-modes').hidden = settings.mode === 'free';
  $('reference-key').hidden = liveChart();
  needsDraw = true;
}

function renderNotes() {
  $('note-cards').replaceChildren(...notes.map((note, index) => {
    const card = document.createElement('button');
    const name = settings.language === 'ru' ? note.name : note.latin;
    card.type = 'button';
    card.className = 'note-card';
    card.dataset.note = index;
    card.setAttribute('aria-label', `${t('playNote')} ${noteName(note.midi, settings.language)}`);
    const fill = document.createElement('span');
    fill.className = 'note-fill';
    fill.setAttribute('aria-hidden', 'true');
    const label = document.createElement('strong');
    label.textContent = name;
    const frequency = document.createElement('small');
    frequency.textContent = localizedFrequency(midiToHz(note.midi));
    const score = document.createElement('span');
    score.className = 'note-score';
    card.append(fill, label, frequency, score);
    return card;
  }));
}

function selectedIndex() {
  return playback?.index ?? session?.index ?? lastSession?.index ?? 0;
}

function renderNoteProgress() {
  const trial = session ?? lastSession;
  for (const card of all('[data-note]')) {
    const i = Number(card.dataset.note);
    const score = trial?.results[i];
    card.classList.toggle('active', settings.mode !== 'free' && !lastSession && i === selectedIndex());
    card.classList.toggle('missed', score != null && score < 60);
    const hold = session?.index === i ? Math.min(1, session.hold / notes[i].duration) : 0;
    card.firstElementChild.style.width = `${score != null ? 100 : hold * 100}%`;
    setText(card.lastElementChild, score != null ? `${score}%` : '');
  }
}

function renderControls() {
  const busy = phase !== 'idle';
  for (const control of all('[data-mode], [data-bpm], [data-source], [data-note], #difficulty, #octave, #any-octave, #sensitivity')) {
    control.disabled = busy;
  }
  $('listen').disabled = busy;
  $('start').disabled = busy;
  $('stop').disabled = !busy;
  let startLabel = settings.mode === 'free' ? 'startTuner' : lastSession ? 'restart' : 'start';
  if (phase === 'permission') startLabel = 'starting';
  else if (busy && phase !== 'sample') startLabel = 'practicing';
  setText($('start').lastElementChild, t(startLabel));
  setText($('listen').lastElementChild, t(phase === 'sample' ? 'playing' : 'listen'));
  setText($('mic-label'), t(stream ? 'micOn' : phase === 'permission' ? 'micRequest' : 'micOff'));
  $('mic-label').parentElement.classList.toggle('active', Boolean(stream));
}

function renderStage(now) {
  let label = '';
  if (phase === 'sample' || phase === 'echo') label = t('playing');
  else if (phase === 'countdown') {
    const beatsLeft = Math.ceil((session.startTime - now - 100) / (60000 / settings.bpm));
    label = t('countdown')(Math.max(1, beatsLeft));
  } else if (phase === 'running') {
    if (lastFrequency && settings.mode !== 'free') label = t('progressNote')(session.index + 1, notes.length);
    if (!lastFrequency) label = t(lastRms >= settings.sensitivity ? 'steady' : 'waiting');
  }
  setText($('stage-label'), label);
}

function renderPitch() {
  const free = settings.mode === 'free';
  const heardMidi = lastFrequency ? hzToMidi(lastFrequency) : null;
  const midi = free ? (heardMidi === null ? null : Math.round(heardMidi)) : notes[selectedIndex()].midi;
  const cents = midi === null ? null : centsFrom(lastFrequency, midi, !free && settings.anyOctave);
  const range = free ? 50 : tolerance();
  const gaugeMax = free ? 100 : Math.max(100, Math.ceil(range * 1.2 / 50) * 50);
  const inRange = withinTolerance(cents, range);
  const change = inRange && session?.transitionPitch != null;
  let message = 'deviation';
  if (cents !== null) message = change ? 'changePitch' : inRange ? 'inRange' : cents < 0 ? 'raisePitch' : 'lowerPitch';

  setText($('heard-note'), heardMidi === null ? '—' : noteName(heardMidi, settings.language));
  setText($('heard-frequency'), localizedFrequency(lastFrequency));
  setText($('target-note'), midi === null ? '—' : noteName(midi, settings.language));
  setText($('target-frequency'), localizedFrequency(midi === null ? null : midiToHz(midi)));
  setText($('intonation-message'), t(message));
  $('intonation-message').classList.toggle('good', inRange && !change);
  const zone = document.querySelector('.gauge-zone');
  zone.style.left = `${50 - 50 * range / gaugeMax}%`;
  zone.style.width = `${100 * range / gaugeMax}%`;
  const needle = $('gauge-needle');
  needle.hidden = cents === null;
  needle.style.left = `${50 + 50 * Math.max(-1, Math.min(1, (cents ?? 0) / gaugeMax))}%`;
  const rounded = Math.round(cents);
  setText($('cents-value'), cents === null ? '—' : `${rounded > 0 ? '+' : ''}${rounded} ${t('cents')}`);
  setText($('min-cents'), `−${gaugeMax}`);
  setText($('max-cents'), `+${gaugeMax}`);
  $('input-level').value = Math.min(1, lastRms * 4.5);
}

function refresh(now = performance.now()) {
  renderControls();
  renderPitch();
  renderNoteProgress();
  renderStage(now);
  needsDraw = true;
}

async function ensureAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  try {
    if (!audio || audio.state === 'closed') {
      audio = new Audio();
      reference = new ReferenceAudio(audio);
      reference.setVolume(settings.volume);
    }
    if (audio.state !== 'running') await audio.resume();
  } catch {
    throw new Error('unavailableAudio');
  }
}

function releaseMicrophone() {
  if (stream) {
    const old = stream;
    stream = null;
    for (const track of old.getTracks()) {
      track.onended = null;
      track.stop();
    }
  }
  micSource?.disconnect();
  analyser?.disconnect();
  silentOutput?.disconnect();
  micSource = null;
  analyser = null;
  silentOutput = null;
  buffer = null;
  recentPitch = [];
}

function stopAll(key = '', { preserveTrace = false, error = false } = {}) {
  generation++;
  reference?.stop();
  releaseMicrophone();
  phase = 'idle';
  session = null;
  playback = null;
  lastFrequency = null;
  lastRms = 0;
  if (!preserveTrace) {
    traceStart = null;
    points = [];
    lastSession = null;
    $('result').hidden = true;
  }
  setNotice(key, error);
  refresh();
}

function microphoneError(error) {
  const named = {
    NotAllowedError: 'micDenied',
    SecurityError: 'micDenied',
    NotFoundError: 'micMissing',
    NotReadableError: 'micBusy',
  };
  if (['unavailableMic', 'unavailableAudio', 'unavailableRecording'].includes(error.message)) return error.message;
  return named[error.name] ?? 'micFailed';
}

function beginSession(count = 0) {
  const beat = 60000 / settings.bpm;
  const delay = count ? count * beat + 100 : 0;
  const startTime = performance.now() + delay;
  session = new TrainingSession({ mode: settings.mode, notes, tolerance: tolerance(), anyOctave: settings.anyOctave, startTime });
  phase = count ? 'countdown' : 'running';
  traceStart = startTime;
  points = [];
  recentPitch = [];
  const clickStart = audio.currentTime + 0.1;
  for (let i = 0; i < count; i++) reference.countIn(i === count - 1 ? 510 : 380, clickStart + i * beat / 1000);
  refresh();
}

async function scheduleMelody(noteIndices, token, echo = false) {
  await reference.prepare(settings.audioSource);
  if (token !== generation) return;
  let cursor = audio.currentTime + 0.1;
  const spans = [];
  for (const index of noteIndices) {
    const note = notes[index];
    const duration = note.duration / 1000;
    reference.play(settings.audioSource, index, midiToHz(note.midi), cursor, duration);
    spans.push({ index, start: cursor, end: cursor + duration });
    cursor += duration;
  }
  playback = { end: cursor + 0.16, spans, index: noteIndices[0], echo };
  refresh();
}

async function startTraining() {
  stopAll();
  const token = generation;
  phase = 'permission';
  setNotice('micPermission');
  refresh();
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('unavailableMic');
    await ensureAudio();
    if (token !== generation) return;
    const input = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    });
    if (token !== generation) {
      for (const track of input.getTracks()) track.stop();
      return;
    }
    stream = input;
    micSource = audio.createMediaStreamSource(stream);
    analyser = audio.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    buffer = new Float32Array(analyser.fftSize);
    silentOutput = audio.createGain();
    silentOutput.gain.value = 0;
    micSource.connect(analyser).connect(silentOutput).connect(audio.destination);
    for (const track of stream.getAudioTracks()) {
      track.onended = () => stopAll('micDisconnected', { preserveTrace: true, error: true });
    }
    setNotice();
    if (settings.mode === 'echo') {
      phase = 'echo';
      refresh();
      await scheduleMelody(indices, token, true);
    } else {
      beginSession(settings.mode === 'rhythm' ? 3 : 0);
    }
  } catch (error) {
    if (token === generation) stopAll(microphoneError(error), { error: true });
  }
}

async function playReference(noteIndices = indices) {
  stopAll();
  const token = generation;
  phase = 'sample';
  refresh();
  try {
    await ensureAudio();
    if (token === generation) await scheduleMelody(noteIndices, token);
  } catch (error) {
    const message = error.message === 'unavailableRecording' ? error.message : 'unavailableAudio';
    if (token === generation) stopAll(message, { error: true });
  }
}

function completeSession() {
  lastSession = session;
  const score = lastSession.score;
  history.unshift({
    date: new Date().toISOString(), score, mode: settings.mode, bpm: settings.bpm, tolerance: tolerance(),
    octave: settings.octave, anyOctave: settings.anyOctave, notes: [...lastSession.results],
  });
  history = history.slice(0, 50);
  const saved = saveLocal(HISTORY_KEY, history);
  setText($('result-score'), `${score}%`);
  $('result').hidden = false;
  stopAll(saved ? '' : 'historyUnavailable', { preserveTrace: true });
  renderHistory();
}

function playbackProgress() {
  if (!playback) return session?.progress;
  const note = notes[playback.index];
  const span = playback.spans.find(entry => entry.index === playback.index);
  const offset = notes.slice(0, playback.index).reduce((ms, entry) => ms + entry.duration, 0);
  const elapsed = Math.max(0, Math.min(note.duration, (audio.currentTime - span.start) * 1000));
  const total = notes.reduce((ms, entry) => ms + entry.duration, 0);
  return (offset + elapsed) / total;
}

function liveFrame(now) {
  analyser.getFloatTimeDomainData(buffer);
  const { frequency, rms } = detector.detect(buffer, audio.sampleRate, settings.sensitivity);
  if (frequency) {
    recentPitch.push(frequency);
    if (recentPitch.length > 3) recentPitch.shift();
  } else {
    recentPitch = [];
  }
  lastFrequency = recentPitch.length ? [...recentPitch].sort((a, b) => a - b)[Math.floor(recentPitch.length / 2)] : null;
  lastRms = rms;
  const target = notes[session.index].midi;
  // The trace keeps the original octave. Only the follow view aligns it to the target.
  const midi = frequency ? hzToMidi(frequency) : null;
  const aligned = midi !== null && settings.anyOctave ? midi + Math.round((target - midi) / 12) * 12 : midi;
  session.tick(frequency, now);
  points.push({ time: now, progress: session.progress, midi, aligned });
  if (points.length > 1800) points.shift();
  if (session.done) completeSession();
  else {
    renderPitch();
    renderNoteProgress();
    renderStage(now);
    needsDraw = true;
  }
}

function frame(now) {
  if (playback) {
    const active = playback.spans.find(span => audio.currentTime >= span.start && audio.currentTime < span.end);
    if (active && active.index !== playback.index) {
      playback.index = active.index;
      renderPitch();
      renderNoteProgress();
    }
    if (audio.currentTime >= playback.end) {
      const echo = playback.echo;
      playback = null;
      if (echo) beginSession(2);
      else stopAll();
    }
    needsDraw = true;
  }
  if (phase === 'countdown') {
    if (now >= session.startTime) phase = 'running';
    else renderStage(now);
  }
  if (phase === 'running') liveFrame(now);
  if (needsDraw) {
    chart.draw({
      notes, points, now, traceStart, running: phase === 'running', live: liveChart(),
      selected: lastSession ? undefined : selectedIndex(), cursor: playbackProgress(),
      tolerance: tolerance(), locale: settings.language, seconds: t('seconds'),
    });
    needsDraw = false;
  }
}

function renderHistory() {
  $('clear-history').disabled = !history.length;
  setText($('clear-history'), t(clearTimer ? 'confirmClear' : 'clear'));
  setText($('stat-count'), history.length);
  setText($('stat-best'), history.length ? `${Math.max(...history.map(entry => entry.score))}%` : '—');
  const average = history.reduce((sum, entry) => sum + entry.score, 0) / history.length;
  setText($('stat-average'), history.length ? `${Math.round(average)}%` : '—');
  const container = $('history');
  container.replaceChildren();
  if (!history.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = t('empty');
    container.append(empty);
    return;
  }
  for (const entry of history) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const time = document.createElement('time');
    time.dateTime = entry.date;
    time.textContent = new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.date));
    const summary = document.createElement('div');
    const mode = document.createElement('span');
    mode.textContent = t(entry.mode);
    const detail = document.createElement('small');
    const octave = entry.anyOctave ? t('anyOctaveHistory') : t('fixedOctave')(entry.octave);
    detail.textContent = `${entry.bpm} BPM · ${formatTolerance(entry.tolerance)} · ${octave}`;
    summary.append(mode, detail);
    const score = document.createElement('strong');
    score.className = 'history-score';
    score.textContent = `${entry.score}%`;
    row.append(time, summary, score);
    container.append(row);
  }
}

function showPage() {
  const hash = location.hash.slice(1);
  const page = pages.includes(hash) ? hash : 'practice';
  if (page !== 'practice' && settingsDialog.open) settingsDialog.close();
  if (page !== 'practice' && phase !== 'idle') stopAll('', { preserveTrace: true });
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
    setText($('clear-history'), t('clear'));
  }
  for (const el of all('.page')) el.hidden = el.id !== `page-${page}`;
  for (const el of all('[data-page]')) {
    if (el.dataset.page === page) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
  if (page === 'practice') requestAnimationFrame(resizeChart);
  window.scrollTo(0, 0);
}

function resizeChart() {
  chart.resize();
  needsDraw = true;
}

function placeSettings() {
  const container = compactLayout.matches ? settingsDialog : settingsHome;
  if (container === settingsHome && settingsDialog.open) settingsDialog.close();
  if (settingsPanel.parentElement !== container) container.append(settingsPanel);
}

for (const button of all('[data-language]')) {
  button.addEventListener('click', () => {
    settings.language = button.dataset.language;
    saveLocal(SETTINGS_KEY, settings);
    localize();
  });
}
for (const button of all('[data-chart]')) {
  button.addEventListener('click', () => {
    settings.chart = button.dataset.chart;
    saveLocal(SETTINGS_KEY, settings);
    renderChartMode();
  });
}
for (const button of all('[data-source]')) {
  button.addEventListener('click', () => {
    settings.audioSource = button.dataset.source;
    saveLocal(SETTINGS_KEY, settings);
    setNotice();
    press('[data-source]', el => el.dataset.source === settings.audioSource);
  });
}
for (const [selector, key, numeric] of [['[data-mode]', 'mode', false], ['[data-bpm]', 'bpm', true]]) {
  for (const button of all(selector)) {
    button.addEventListener('click', () => {
      const value = numeric ? Number(button.dataset[key]) : button.dataset[key];
      if (settings[key] === value) return;
      settings[key] = value;
      saveLocal(SETTINGS_KEY, settings);
      stopAll();
      renderSettings();
    });
  }
}
for (const [id, key] of [['difficulty', 'difficulty'], ['octave', 'octave'], ['sensitivity', 'sensitivity'], ['any-octave', 'anyOctave']]) {
  $(id).addEventListener('change', ({ target }) => {
    settings[key] = target.type === 'checkbox' ? target.checked : key === 'difficulty' ? target.value : Number(target.value);
    saveLocal(SETTINGS_KEY, settings);
    stopAll();
    renderSettings();
  });
}

$('volume').addEventListener('input', ({ target }) => {
  settings.volume = Number(target.value);
  setText($('volume-value'), `${settings.volume}%`);
  reference?.setVolume(settings.volume);
  saveLocal(SETTINGS_KEY, settings);
});
$('note-cards').addEventListener('click', ({ target }) => {
  const note = target.closest('[data-note]');
  if (note) playReference([Number(note.dataset.note)]);
});
$('listen').addEventListener('click', () => playReference());
$('start').addEventListener('click', () => {
  if (compactLayout.matches) canvas.closest('.chart').scrollIntoView({ block: 'nearest' });
  startTraining();
});
$('stop').addEventListener('click', () => stopAll('stopped', { preserveTrace: true }));
$('open-settings').addEventListener('click', () => settingsDialog.showModal());
$('close-settings').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', event => {
  if (event.target === settingsDialog) settingsDialog.close();
});
compactLayout.addEventListener('change', placeSettings);
$('clear-history').addEventListener('click', () => {
  if (!clearTimer) {
    setText($('clear-history'), t('confirmClear'));
    clearTimer = setTimeout(() => {
      clearTimer = null;
      setText($('clear-history'), t('clear'));
    }, 4500);
    return;
  }
  clearTimeout(clearTimer);
  clearTimer = null;
  history = [];
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* Storage is optional. */ }
  renderHistory();
});

window.addEventListener('hashchange', showPage);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && phase !== 'idle') stopAll('hidden', { preserveTrace: true });
});
window.addEventListener('pagehide', () => stopAll('', { preserveTrace: true }));
new ResizeObserver(resizeChart).observe(canvas);

placeSettings();
localize();
showPage();
// Keep audio analysis running when paint callbacks are throttled.
setInterval(() => frame(performance.now()), 30);
