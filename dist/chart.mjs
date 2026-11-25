import { noteName } from './pitch.mjs';

const TRACE_WINDOW = 8000;
const colors = {
  axis: '#ad9a83',
  grid: '#352820',
  divide: '#5c4736',
  target: '#a78552',
  active: '#e5bc79',
  band: '#ac80421f',
  whistle: '#a5cabb',
  cursor: '#dcbb8588',
};

export class PitchChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize() {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(height * scale);
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
  }

  draw({ notes, points, now, traceStart, running, live, selected, cursor, tolerance, locale, seconds }) {
    const { ctx, width, height } = this;
    if (!width || !height) return;
    const left = locale === 'ru' ? 56 : 38;
    const right = width - 14;
    const top = 13;
    const bottom = height - 24;
    const total = notes.reduce((ms, note) => ms + note.duration, 0);
    const lastPoint = points.at(-1);
    const end = live ? Math.max((traceStart ?? 0) + TRACE_WINDOW, running ? now : (lastPoint?.time ?? 0)) : 0;
    const origin = end - TRACE_WINDOW;
    const visible = live ? points.filter(point => point.time >= origin) : points;
    const pitches = live ? visible.filter(point => point.midi !== null).map(point => point.midi) : [];
    const axisPitches = pitches.length ? pitches : notes.map(note => note.midi);
    const pad = live ? 3 : Math.max(1.8, tolerance / 100 + 0.4);
    const low = Math.floor(Math.min(...axisPitches) - pad);
    const high = Math.ceil(Math.max(...axisPitches) + pad);
    const x = unit => left + unit * (right - left);
    const y = midi => bottom - (midi - low) / (high - low) * (bottom - top);
    const labelFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    const step = Math.max(1, Math.ceil((high - low) / 7));
    for (let midi = low; midi <= high; midi += step) {
      const py = y(midi);
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.stroke();
      ctx.fillStyle = colors.axis;
      ctx.fillText(noteName(midi, locale), 1, py);
    }

    const ticks = live ? 4 : 3;
    const timeOffset = live ? origin - (traceStart ?? origin) : 0;
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i <= ticks; i++) {
      const px = x(i / ticks);
      ctx.textAlign = i === 0 ? 'left' : i === ticks ? 'right' : 'center';
      ctx.fillStyle = colors.axis;
      const tickTime = timeOffset + i / ticks * (live ? TRACE_WINDOW : total);
      ctx.fillText(`${labelFormat.format(tickTime / 1000)} ${seconds}`, px, height - 4);
      if (live) {
        ctx.strokeStyle = colors.grid;
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
        ctx.stroke();
      }
    }

    if (!live) {
      let offset = 0;
      for (const [i, note] of notes.entries()) {
        const a = x(offset / total);
        offset += note.duration;
        const b = x(offset / total);
        const py = y(note.midi);
        const band = Math.max(6, (bottom - top) * (tolerance / 100) / (high - low));
        if (i === selected) {
          ctx.fillStyle = colors.band;
          ctx.fillRect(a + 2, py - band, b - a - 4, 2 * band);
        }
        if (i !== 0) {
          ctx.strokeStyle = colors.divide;
          ctx.lineWidth = 1;
          ctx.lineCap = 'butt';
          ctx.setLineDash([3, 5]);
          ctx.beginPath();
          ctx.moveTo(a, top);
          ctx.lineTo(a, bottom);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.strokeStyle = i === selected ? colors.active : colors.target;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a + 9, py);
        ctx.lineTo(b - 9, py);
        ctx.stroke();
      }
      if (cursor !== undefined) {
        ctx.strokeStyle = colors.cursor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x(cursor), top - 4);
        ctx.lineTo(x(cursor), bottom);
        ctx.stroke();
      }
    }

    const pointX = point => live ? (point.time - origin) / TRACE_WINDOW : point.progress;
    const pointY = point => live ? point.midi : point.aligned;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left - 3, top - 4, right - left + 6, bottom - top + 8);
    ctx.clip();
    ctx.strokeStyle = colors.whistle;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let previous = null;
    for (const point of visible) {
      if (point.midi === null) {
        previous = null;
        continue;
      }
      const px = x(pointX(point));
      const py = y(pointY(point));
      if (!previous || point.time - previous.time > 150 || pointX(point) < pointX(previous)) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
      previous = point;
    }
    ctx.stroke();
    if (lastPoint?.midi != null) {
      ctx.fillStyle = colors.whistle;
      ctx.beginPath();
      ctx.arc(x(pointX(lastPoint)), y(pointY(lastPoint)), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
