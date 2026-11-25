import { PitchDetector, TrainingSession, sequence, midiToHz, hzToMidi, noteName, centsFrom } from './pitch.mjs';

const $ = id => document.getElementById(id);
const modeLabels = { steps: 'По нотам', echo: 'Эхо', rhythm: 'В ритме', free: 'Тюнер' };
const descriptions = {
  steps: 'Попади в ноту и удержи её. Продолжим, когда будешь готов.',
  echo: 'Сначала послушай сигнал. Потом повтори все четыре ноты в своём темпе.',
  rhythm: 'Три доли на подготовку. Затем свисти вместе с движением курсора.',
  free: 'Свисти свободно. Тюнер покажет ближайшую ноту и точность попадания.',
};
const defaults = { mode: 'steps', bpm: 90, tolerance: 30, octave: 5, anyOctave: true, sensitivity: 0.006, volume: 55 };
let settings = { ...defaults };
try {
  const saved = JSON.parse(localStorage.getItem('mockingjay-settings') || '{}');
  for (const [key, options] of Object.entries({ mode: Object.keys(modeLabels), bpm: [60, 90, 120], tolerance: [15, 30, 50], octave: [4, 5, 6], sensitivity: [0.003, 0.006, 0.018] })) if (options.includes(saved[key])) settings[key] = saved[key];
  if (typeof saved.anyOctave === 'boolean') settings.anyOctave = saved.anyOctave;
  if (Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100) settings.volume = saved.volume;
} catch { /* Storage is optional. */ }
let history = [];
try {
  const saved = JSON.parse(localStorage.getItem('mockingjay-history') || '[]');
  if (Array.isArray(saved)) history = saved.filter(x => x && Number.isFinite(x.score) && x.score >= 0 && x.score <= 100 && ['steps', 'echo', 'rhythm'].includes(x.mode) && Number.isFinite(x.bpm) && Number.isFinite(x.tolerance) && Number.isFinite(x.octave) && Number.isFinite(Date.parse(x.date))).slice(0, 50);
} catch { /* A new browser simply starts with no history. */ }

let audio = null, stream = null, source = null, analyser = null, silentOutput = null, buffer = null;
let phase = 'idle', session = null, lastSession = null, playback = null, generation = 0;
let lastFrequency = null, recentPitch = [], points = [], needsDraw = true;
const oscillators = new Set();
const detector = new PitchDetector();
const canvas = $('pitch-canvas'), ctx = canvas.getContext('2d');
let canvasWidth = 600, canvasHeight = 175;

function persistSettings() { try { localStorage.setItem('mockingjay-settings', JSON.stringify(settings)); } catch {} }
function notice(message = '', error = false) { $('notice').hidden = !message; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function currentNotes() { return session?.notes || sequence(settings.octave, settings.bpm); }
function selectedIndex() { return playback?.index ?? session?.index ?? 0; }
function targetMidi() {
  if (settings.mode === 'free' && lastFrequency) return Math.round(hzToMidi(lastFrequency));
  return currentNotes()[Math.min(3, selectedIndex())].midi;
}
function updateSettingsUI() {
  document.querySelectorAll('[data-mode]').forEach(b => { const active = b.dataset.mode === settings.mode; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
  document.querySelectorAll('[data-bpm]').forEach(b => { const active = +b.dataset.bpm === settings.bpm; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
  $('difficulty').value = settings.tolerance; $('octave').value = settings.octave; $('sensitivity').value = settings.sensitivity; $('volume').value = settings.volume; $('any-octave').checked = settings.anyOctave;
  $('tempo-value').textContent = settings.bpm + ' BPM'; $('tolerance-label').textContent = '±' + settings.tolerance + ' центов';
  $('mode-description').textContent = descriptions[settings.mode];
  $('speed-help').textContent = settings.mode === 'rhythm' ? 'Задаёт скорость курсора и длину нот.' : settings.mode === 'free' ? 'В тюнере скорость не используется.' : 'Задаёт длительность удержания нот.';
  document.querySelector('.gauge-zone').style.left = (50 - settings.tolerance / 2) + '%';
  document.querySelector('.gauge-zone').style.width = settings.tolerance + '%';
  renderNotes(); updateControls(); updatePitch(null, 0); needsDraw = true;
}
function renderNotes() {
  $('note-cards').innerHTML = sequence(settings.octave, settings.bpm).map((n, i) => `<button class="note-card${i === 0 && settings.mode !== 'free' ? ' active' : ''}" data-note="${i}" aria-label="Послушать ${n.name}, ${noteName(n.midi)}"><span class="note-fill"></span><strong>${n.name}</strong><small>${noteName(n.midi)} · ${Math.round(midiToHz(n.midi))} Гц</small><span class="note-duration" aria-hidden="true">${i === 3 ? '𝅗𝅥' : '♪'}</span><span class="note-tag"></span></button>`).join('');
  $('note-cards').querySelectorAll('button').forEach(b => b.addEventListener('click', () => playReference([+b.dataset.note])));
}
function updateControls() {
  const busy = phase !== 'idle';
  document.querySelectorAll('[data-mode],[data-bpm],#difficulty,#octave,#any-octave,#sensitivity,[data-note]').forEach(b => { b.disabled = busy; });
  $('listen').disabled = busy;
  $('start').disabled = busy;
  $('stop').disabled = !busy;
  $('start').querySelector('span').textContent = phase === 'permission' ? 'Ждём разрешение…' : phase === 'running' || phase === 'countdown' || phase === 'echo' ? 'Тренировка идёт' : settings.mode === 'free' ? 'Включить тюнер' : lastSession ? 'Попробовать ещё раз' : 'Начать тренировку';
  $('listen').querySelector('span').textContent = phase === 'sample' ? 'Звучит образец' : 'Послушать';
  $('mic-label').textContent = stream ? 'Микрофон включён' : phase === 'permission' ? 'Запрос микрофона' : 'Микрофон выключен';
  $('mic-description').textContent = stream ? 'Слушаем только в этом браузере' : phase === 'permission' ? 'Разреши доступ в браузере' : 'Включится, когда начнёшь';
  $('session-hint').textContent = settings.mode === 'rhythm' ? 'Следуй за курсором' : settings.mode === 'free' ? 'Без оценки' : 'В твоём темпе';
}
function updateNoteProgress() {
  const training = session || lastSession;
  document.querySelectorAll('[data-note]').forEach((card, i) => {
    const score = training?.results[i];
    card.classList.toggle('active', settings.mode !== 'free' && i === selectedIndex() && !lastSession);
    card.classList.toggle('done', score !== null && score !== undefined && score >= 60);
    card.classList.toggle('missed', score !== null && score !== undefined && score < 60);
    const progress = score !== null && score !== undefined ? 100 : session && i === session.index ? Math.min(100, session.hold / session.notes[i].duration * 100) : 0;
    card.querySelector('.note-fill').style.width = progress + '%';
    card.querySelector('.note-tag').textContent = score !== null && score !== undefined ? score + '%' : '';
  });
}
function updatePitch(frequency, rms) {
  lastFrequency = frequency;
  const midi = targetMidi();
  $('heard-note').textContent = frequency ? noteName(hzToMidi(frequency)) : '—';
  $('heard-frequency').textContent = frequency ? Math.round(frequency) + ' Гц' : stream ? 'Свистни ровно' : 'Ждём звук';
  $('target-note').textContent = settings.mode === 'free' && !frequency ? '—' : noteName(midi);
  $('target-frequency').textContent = settings.mode === 'free' && !frequency ? 'Любая нота' : Math.round(midiToHz(midi)) + ' Гц';
  $('input-level').style.width = Math.min(100, rms * 450) + '%';
  const cents = centsFrom(frequency, midi, settings.mode === 'free' ? false : settings.anyOctave);
  const good = cents !== null && Math.abs(cents) <= settings.tolerance;
  const message = $('intonation-message');
  message.textContent = cents === null ? 'Найди свой звук' : good ? 'В ноту!' : cents < 0 ? 'Свистни чуть выше' : 'Свистни чуть ниже';
  message.classList.toggle('good', good); message.classList.toggle('off', cents !== null && !good);
  $('gauge-needle').style.opacity = cents === null ? 0 : 1;
  $('gauge-needle').style.left = (50 + Math.max(-100, Math.min(100, cents || 0)) / 2) + '%';
  $('cents-value').textContent = cents === null ? 'отклонение в центах' : (cents > 0 ? '+' : '') + Math.round(cents) + ' центов';
}
async function ensureAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('Этот браузер не поддерживает работу со звуком. Открой сайт в современном Chrome, Edge, Firefox или Safari.');
  if (!audio || audio.state === 'closed') audio = new Audio();
  if (audio.state === 'suspended') await audio.resume();
  return audio;
}
function tone(frequency, start, duration, amplitude = 1) {
  const oscillator = audio.createOscillator(), gain = audio.createGain();
  oscillator.type = 'sine'; oscillator.frequency.value = frequency;
  const level = settings.volume / 100 * 0.22 * amplitude;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(level, start + Math.min(0.025, duration / 4));
  gain.gain.setValueAtTime(level * 0.85, start + Math.max(0.03, duration - 0.045));
  gain.gain.linearRampToValueAtTime(0, start + duration);
  oscillator.connect(gain).connect(audio.destination); oscillator.start(start); oscillator.stop(start + duration + 0.02);
  oscillators.add(oscillator);
  oscillator.onended = () => { oscillators.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
}
function silenceOutput() { for (const oscillator of oscillators) { try { oscillator.stop(); } catch {} } oscillators.clear(); }
function releaseMicrophone() {
  if (stream) { const old = stream; stream = null; old.getTracks().forEach(track => { track.onended = null; track.stop(); }); }
  try { source?.disconnect(); analyser?.disconnect(); silentOutput?.disconnect(); } catch {}
  source = null; analyser = null; silentOutput = null; buffer = null; recentPitch = [];
}
function stopAll(message = '', keepTrace = false) {
  generation++; silenceOutput(); releaseMicrophone(); phase = 'idle'; session = null; playback = null;
  if (!keepTrace) { points = []; lastSession = null; $('result').hidden = true; }
  updateControls(); updatePitch(null, 0); updateNoteProgress(); needsDraw = true;
  $('stage-label').textContent = 'Слушаем тишину'; $('chart-caption').textContent = 'Вдохни. Здесь появится твоя мелодия.'; $('note-position').textContent = '4 ноты · 1 фраза';
  notice(message);
}
function microphoneError(error) {
  const messages = {
    NotAllowedError: 'Доступ к микрофону не разрешён. Открой настройки разрешений рядом с адресом сайта и разреши микрофон. Если сайт открыт внутри приложения, открой эту ссылку в отдельной вкладке браузера.',
    NotFoundError: 'Микрофон не найден. Подключи микрофон или гарнитуру и попробуй ещё раз.',
    NotReadableError: 'Не удалось включить микрофон. Проверь его в настройках системы и закрой приложения, которые могут его занимать.',
    AbortError: 'Подключение микрофона прервалось. Попробуй ещё раз.',
    SecurityError: 'Браузер запрещает микрофон на этой странице. Открой сайт по HTTPS в отдельной вкладке.',
  };
  return messages[error.name] || error.message || 'Не удалось получить звук. Проверь микрофон и попробуй ещё раз.';
}
async function startTraining() {
  stopAll();
  const token = generation;
  phase = 'permission'; updateControls(); $('stage-label').textContent = 'Подключаем микрофон';
  notice('Разреши микрофон в запросе браузера. Можно отменить кнопкой «Остановить».');
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Микрофон доступен по HTTPS или на localhost. Открой сайт по его HTTPS-ссылке в отдельной вкладке браузера.');
    await ensureAudio();
    if (token !== generation) return;
    const input = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false });
    if (token !== generation) { input.getTracks().forEach(track => track.stop()); return; }
    stream = input; source = audio.createMediaStreamSource(stream); analyser = audio.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;
    buffer = new Float32Array(analyser.fftSize); silentOutput = audio.createGain(); silentOutput.gain.value = 0;
    source.connect(analyser); analyser.connect(silentOutput).connect(audio.destination);
    stream.getAudioTracks().forEach(track => { track.onended = () => { stopAll(); notice('Микрофон отключился. Подключи его и начни заново.', true); }; });
    notice();
    if (settings.mode === 'echo') { phase = 'echo'; scheduleMelody([0, 1, 2, 3], true); }
    else beginSession(settings.mode === 'rhythm' ? 3 : 0);
    updateControls();
  } catch (error) { if (token !== generation) return; stopAll(); notice(microphoneError(error), true); }
}
function beginSession(count = 0) {
  const beat = 60000 / settings.bpm;
  const delay = count ? count * beat + 120 : 0;
  const startTime = performance.now() + delay;
  session = new TrainingSession({ mode: settings.mode, notes: sequence(settings.octave, settings.bpm), tolerance: settings.tolerance, anyOctave: settings.anyOctave, startTime });
  phase = count ? 'countdown' : 'running'; points = []; recentPitch = [];
  for (let i = 0; i < count; i++) tone(i === count - 1 ? 900 : 650, audio.currentTime + i * beat / 1000, 0.07, 0.3);
  updateControls(); needsDraw = true;
}
function scheduleMelody(indices, echo = false) {
  const notes = sequence(settings.octave, settings.bpm);
  let cursor = audio.currentTime + 0.10;
  const start = cursor, spans = [];
  for (const index of indices) {
    const duration = notes[index].duration / 1000;
    spans.push({ index, start: cursor, end: cursor + duration });
    tone(midiToHz(notes[index].midi), cursor, duration * 0.90);
    cursor += duration;
  }
  playback = { start, end: cursor + 0.2, spans, index: indices[0], echo };
  needsDraw = true;
}
async function playReference(indices = [0, 1, 2, 3]) {
  stopAll(); const token = generation; phase = 'sample'; updateControls();
  try { await ensureAudio(); if (token !== generation) return; scheduleMelody(indices); }
  catch (error) { if (token !== generation) return; stopAll(); notice(error.message, true); }
}
function completeSession() {
  lastSession = session; session = null; phase = 'idle'; releaseMicrophone(); silenceOutput();
  const score = lastSession.score;
  history.unshift({ date: new Date().toISOString(), score, mode: settings.mode, bpm: settings.bpm, tolerance: settings.tolerance, octave: settings.octave, anyOctave: settings.anyOctave, notes: [...lastSession.results] });
  history = history.slice(0, 50);
  try { localStorage.setItem('mockingjay-history', JSON.stringify(history)); } catch { notice('Результат есть в этой сессии, но браузер запретил сохранение истории.'); }
  $('result').hidden = false;
  $('result-title').textContent = score >= 90 ? 'Сигнал принят.' : score >= 65 ? 'Мелодия уже узнаваема.' : 'Ещё немного практики.';
  $('result-description').textContent = settings.mode === 'rhythm' ? 'Оценка учитывает точность и долю времени в нужной ноте.' : 'Все четыре ноты собраны. Оценка показывает точность удержания.';
  $('result-score').textContent = score + '%';
  $('stage-label').textContent = 'Фраза завершена'; $('chart-caption').textContent = 'Это твой сигнал пересмешницы.'; $('note-position').textContent = '4 из 4';
  updateControls(); updatePitch(null, 0); updateNoteProgress(); renderHistory(); needsDraw = true;
}

function frame(now) {
  if (playback && audio) {
    const current = playback.spans.find(s => audio.currentTime >= s.start && audio.currentTime < s.end);
    if (current) playback.index = current.index;
    $('stage-label').textContent = 'Звучит образец'; $('chart-caption').textContent = playback.echo ? 'Запомни мелодию. Скоро твоя очередь.' : 'Три коротких звука. Один длинный.';
    $('note-position').textContent = (playback.index + 1) + ' / 4';
    const n = currentNotes()[playback.index]; $('target-note').textContent = noteName(n.midi); $('target-frequency').textContent = Math.round(midiToHz(n.midi)) + ' Гц';
    updateNoteProgress(); needsDraw = true;
    if (audio.currentTime >= playback.end) { const echo = playback.echo; playback = null; if (echo) beginSession(2); else stopAll(); }
  }
  if (phase === 'countdown' && session) {
    const left = session.startTime - now;
    $('stage-label').textContent = 'Приготовься'; $('chart-caption').textContent = 'Твоя очередь через ' + Math.max(1, Math.ceil(left / (60000 / settings.bpm))); $('note-position').textContent = 'Вдохни';
    if (left <= 0) { phase = 'running'; updateControls(); }
    needsDraw = true;
  }
  if (phase === 'running' && analyser && session) {
    analyser.getFloatTimeDomainData(buffer);
    const reading = detector.detect(buffer, audio.sampleRate, settings.sensitivity);
    const frequency = reading.frequency;
    if (frequency) { recentPitch.push(frequency); if (recentPitch.length > 3) recentPitch.shift(); } else recentPitch = [];
    const displayFrequency = recentPitch.length ? [...recentPitch].sort((a, b) => a - b)[Math.floor(recentPitch.length / 2)] : null;
    // Never score a smoothed or held-over pitch: silence must count as silence.
    const targetBefore = session.notes[session.index].midi;
    session.tick(frequency, now);
    updatePitch(displayFrequency, reading.rms);
    const midi = frequency ? hzToMidi(frequency) : null;
    const aligned = midi !== null && settings.mode !== 'free' && settings.anyOctave ? midi + Math.round((targetBefore - midi) / 12) * 12 : midi;
    points.push({ t: now, x: session.progress, midi: aligned });
    if (points.length > 1800) points.shift();
    $('stage-label').textContent = frequency ? 'Слышим свист' : reading.rms >= settings.sensitivity ? 'Нужен ровный звук' : 'Слушаем тебя';
    $('chart-caption').textContent = settings.mode === 'free' ? 'Пробуй выше и ниже. Найди удобную ноту.' : 'Держи ' + session.notes[session.index].name.toLowerCase() + (session.index === 3 ? ' — чуть дольше.' : ' ровно.');
    $('note-position').textContent = settings.mode === 'free' ? 'Свободный звук' : 'Нота ' + (session.index + 1) + ' из 4';
    updateNoteProgress(); needsDraw = true;
    if (session.done) completeSession();
  }
  if (needsDraw) { draw(now); needsDraw = false; }
}
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvasWidth = rect.width; canvasHeight = rect.height;
  canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); needsDraw = true;
}
function draw(now) {
  const w = canvasWidth, h = canvasHeight, left = 38, right = w - 8, top = 15, bottom = h - 16;
  ctx.clearRect(0, 0, w, h);
  const notes = sequence(settings.octave, settings.bpm), total = notes.reduce((s, n) => s + n.duration, 0);
  const free = settings.mode === 'free';
  const center = free && lastFrequency ? Math.round(hzToMidi(lastFrequency)) : notes[0].midi;
  const low = free ? center - 5 : notes[3].midi - 2, high = free ? center + 5 : notes[1].midi + 2;
  const y = midi => bottom - (Math.max(low, Math.min(high, midi)) - low) / (high - low) * (bottom - top);
  const x = progress => left + Math.max(0, Math.min(1, progress)) * (right - left);
  ctx.font = '10px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let n = Math.ceil(low); n <= high; n += 2) { const py = y(n); ctx.strokeStyle = '#3d5340'; ctx.lineWidth = 0.6; ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke(); ctx.fillStyle = '#839b79'; ctx.fillText(noteName(n), 0, py); }
  if (!free) {
    let offset = 0;
    for (let i = 0; i < notes.length; i++) {
      const a = x(offset / total), b = x((offset + notes[i].duration) / total), py = y(notes[i].midi);
      ctx.fillStyle = '#b8d39212'; ctx.fillRect(a + 4, py - 9, Math.max(1, b - a - 8), 18);
      ctx.strokeStyle = i === selectedIndex() && phase !== 'idle' ? '#e2f4ad' : '#a1bd7d'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(a + 5, py); ctx.lineTo(b - 5, py); ctx.stroke();
      ctx.fillStyle = '#9ab087'; ctx.fillText(['♪', '♪', '♪', '𝅗𝅥'][i], a + 7, bottom + 10);
      if (i) { ctx.setLineDash([2, 5]); ctx.strokeStyle = '#69815a50'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a, top); ctx.lineTo(a, bottom); ctx.stroke(); ctx.setLineDash([]); }
      offset += notes[i].duration;
    }
  }
  const visiblePoints = free ? points.filter(p => now - p.t <= 5500) : points;
  ctx.strokeStyle = '#f3d095'; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
  let previous = null;
  for (const p of visiblePoints) {
    if (p.midi === null) { previous = null; continue; }
    const px = free ? x(1 - (now - p.t) / 5500) : x(p.x), py = y(p.midi);
    if (!previous || p.t - previous.t > 150) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    previous = p;
  }
  ctx.stroke();
  const latest = visiblePoints.at(-1);
  if (latest?.midi != null) { ctx.fillStyle = '#fce0ad'; ctx.beginPath(); ctx.arc(free ? right : x(latest.x), y(latest.midi), 3, 0, Math.PI * 2); ctx.fill(); }
  let cursor = session?.progress;
  if (playback && audio) { const start = notes.slice(0, playback.index).reduce((s, n) => s + n.duration, 0); const span = playback.spans.find(s => s.index === playback.index); cursor = (start + Math.max(0, Math.min(notes[playback.index].duration, (audio.currentTime - span.start) * 1000))) / total; }
  if (!free && cursor !== undefined) { ctx.strokeStyle = '#d9e8b275'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(cursor), 5); ctx.lineTo(x(cursor), h - 3); ctx.stroke(); }
}
function renderHistory() {
  $('stat-count').textContent = history.length;
  $('stat-best').textContent = history.length ? Math.max(...history.map(h => h.score)) + '%' : '—';
  $('stat-average').textContent = history.length ? Math.round(history.reduce((s, h) => s + h.score, 0) / history.length) + '%' : '—';
  $('clear-history').disabled = !history.length;
  const container = $('history'); container.replaceChildren();
  if (!history.length) { const p = document.createElement('p'); p.className = 'empty-history'; p.textContent = 'Первый сигнал ещё впереди. Заверши фразу — и она появится здесь.'; container.append(p); return; }
  for (const entry of history) {
    const row = document.createElement('div'); row.className = 'history-row';
    const date = document.createElement('div'), detail = document.createElement('div'), score = document.createElement('strong');
    const day = document.createElement('p'), time = document.createElement('small');
    const d = new Date(entry.date); day.textContent = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }); time.textContent = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); date.append(day, time);
    const mode = document.createElement('p'), config = document.createElement('small'); mode.textContent = modeLabels[entry.mode]; config.textContent = `${entry.bpm} BPM · ±${entry.tolerance} центов · ${entry.anyOctave ? 'любая октава' : entry.octave + '-я октава'}`; detail.append(mode, config);
    score.className = 'history-score'; score.textContent = entry.score + '%'; row.append(date, detail, score); container.append(row);
  }
}
function showPage(page, updateHash = true) {
  if (!['practice', 'guide', 'progress'].includes(page)) page = 'practice';
  if (page !== 'practice' && phase !== 'idle') stopAll('Тренировка остановлена.');
  document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== 'page-' + page; });
  document.querySelectorAll('.nav-link').forEach(el => { const active = el.dataset.page === page; el.classList.toggle('active', active); if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  if (page === 'progress') renderHistory();
  if (updateHash) window.history.replaceState(null, '', '#' + page);
  if (page === 'practice') requestAnimationFrame(resizeCanvas);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
window.addEventListener('hashchange', () => showPage(location.hash.slice(1), false));
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { stopAll(); settings.mode = b.dataset.mode; persistSettings(); updateSettingsUI(); }));
document.querySelectorAll('[data-bpm]').forEach(b => b.addEventListener('click', () => { settings.bpm = +b.dataset.bpm; lastSession = null; $('result').hidden = true; points = []; persistSettings(); updateSettingsUI(); }));
for (const [id, key] of [['difficulty', 'tolerance'], ['octave', 'octave'], ['sensitivity', 'sensitivity'], ['any-octave', 'anyOctave']]) $(id).addEventListener('change', event => { settings[key] = event.target.type === 'checkbox' ? event.target.checked : +event.target.value; lastSession = null; $('result').hidden = true; points = []; persistSettings(); updateSettingsUI(); });
$('volume').addEventListener('input', event => { settings.volume = +event.target.value; persistSettings(); });
$('start').addEventListener('click', startTraining); $('stop').addEventListener('click', () => stopAll('Тренировка остановлена. Микрофон выключен.')); $('listen').addEventListener('click', () => playReference());
let clearArmed = false;
$('clear-history').addEventListener('click', () => {
  if (!clearArmed) { clearArmed = true; $('clear-history').textContent = 'Нажми ещё раз для удаления'; setTimeout(() => { clearArmed = false; $('clear-history').textContent = 'Очистить историю'; }, 4500); return; }
  history = []; try { localStorage.removeItem('mockingjay-history'); } catch {} clearArmed = false; $('clear-history').textContent = 'Очистить историю'; renderHistory();
});
document.addEventListener('visibilitychange', () => { if (document.hidden && phase !== 'idle') stopAll('Тренировка остановлена, пока вкладка была скрыта. Начни заново, когда будешь готов.'); });
window.addEventListener('pagehide', () => { generation++; releaseMicrophone(); silenceOutput(); });
new ResizeObserver(resizeCanvas).observe(canvas);
updateSettingsUI(); renderHistory(); showPage(location.hash.slice(1) || 'practice', false);
// Embedded browsers can throttle animation frames even while their document is visible.
// Keep audio analysis independent of paint scheduling; hidden pages release the mic above.
setInterval(() => frame(performance.now()), 30);
