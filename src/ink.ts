// Pen ink on notebook pages.
//
// The note is laid out on A4 pages of a fixed logical size (PAGE_W x PAGE_H,
// A4 at 96 dpi). The whole notebook is scaled to fit the screen, but text and
// ink are laid out in these logical units, so a drawing sits in the same
// place on every device. Strokes are stored in page coordinates: they stay
// where you drew them, independent of the text.
//
// Strokes live in CodeMirror state, so Undo/Redo covers ink and text alike.
//
// Input (Pointer Events):
//   pen   -> always draws (real pressure, e.g. S Pen in Chrome on Android)
//   mouse -> draws only when mouse drawing is on; otherwise edits text
//   touch -> never draws: scrolls (see touchscroll.ts) and places the cursor.
//            While the pen is in use, touches are ignored = palm rejection.
// The S Pen side button or a pen's eraser end erases.

import { Facet, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { invertedEffects, redo, undo } from '@codemirror/commands';
import { getStroke } from 'perfect-freehand';
import { icons } from './icons';

// ---------------------------------------------------------------- data

/** A4 at 96 dpi, in CSS px. */
export const PAGE_W = 794;
export const PAGE_H = 1123;

export interface Stroke {
  id: string;
  /** [x, y, pressure] in page coordinates (logical px from the top-left of page 1). */
  pts: [number, number, number][];
  color: string;
  size: number;
  /** true = pressure from the device; false = simulate from speed (mouse). */
  real: boolean;
  /** Snapped geometric shape: drawn with constant width. */
  shape?: boolean;
  /** Old format (v1): document position the points were relative to. Converted on open. */
  anchor?: number;
}

export const COLORS: { name: string; value: string }[] = [
  { name: 'Ink', value: 'auto' }, // black on light theme, white on dark
  { name: 'Red', value: '#e03131' },
  { name: 'Blue', value: '#1c7ed6' },
  { name: 'Green', value: '#2f9e44' },
];
export const SIZES = [2.5, 4, 8];

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------- editor state

export const addStrokes = StateEffect.define<Stroke[]>();
export const removeStrokes = StateEffect.define<string[]>();
export const setPages = StateEffect.define<number>();

export const inkField = StateField.define<Stroke[]>({
  create: () => [],
  update(strokes, tr) {
    for (const e of tr.effects) {
      if (e.is(removeStrokes)) {
        const ids = new Set(e.value);
        strokes = strokes.filter((s) => !ids.has(s.id));
      } else if (e.is(addStrokes)) strokes = [...strokes, ...e.value];
    }
    return strokes;
  },
});

/** Pages the user asked for (the notebook also grows to fit text and ink). */
export const pagesField = StateField.define<number>({
  create: () => 1,
  update(n, tr) {
    for (const e of tr.effects) if (e.is(setPages)) n = e.value;
    return n;
  },
});

/** Undo/redo for ink: record the inverse of whatever changed. Strokes are
 *  compared by object identity, so a moved stroke (same id, new object)
 *  counts as a change. */
const inkHistory = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = [];
  const before = tr.startState.field(inkField, false);
  const after = tr.state.field(inkField, false);
  if (before && after && before !== after) {
    const b = new Set(before);
    const a = new Set(after);
    const added = after.filter((s) => !b.has(s));
    const removed = before.filter((s) => !a.has(s));
    if (added.length) out.push(removeStrokes.of(added.map((s) => s.id)));
    if (removed.length) out.push(addStrokes.of(removed));
  }
  const pb = tr.startState.field(pagesField, false);
  const pa = tr.state.field(pagesField, false);
  if (pb !== undefined && pa !== undefined && pb !== pa) out.push(setPages.of(pb));
  return out;
});

// ---------------------------------------------------------------- tool state

export type ToolMode = 'pen' | 'eraser' | 'lasso';
export const tool = {
  mode: 'pen' as ToolMode,
  color: 'auto',
  size: SIZES[1],
  /** Let the mouse draw (the pen always draws). */
  mouseDraws: false,
};
const toolListeners = new Set<() => void>();
export function setTool(patch: Partial<typeof tool>) {
  Object.assign(tool, patch);
  document.body.classList.toggle('mouse-draws', tool.mouseDraws);
  document.body.dataset.tool = tool.mode;
  toolListeners.forEach((f) => f());
}

// ---------------------------------------------------------------- rendering helpers

const avg = (a: number, b: number) => (a + b) / 2;
function outlineToPath(points: number[][]): string {
  const len = points.length;
  if (len < 4) return '';
  let a = points[0];
  let b = points[1];
  const c = points[2];
  let d = `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${b[0].toFixed(1)},${b[1].toFixed(1)} ${avg(b[0], c[0]).toFixed(1)},${avg(b[1], c[1]).toFixed(1)} T`;
  for (let i = 2; i < len - 1; i++) {
    a = points[i];
    b = points[i + 1];
    d += `${avg(a[0], b[0]).toFixed(1)},${avg(a[1], b[1]).toFixed(1)} `;
  }
  return d + 'Z';
}

export function strokePath(s: Pick<Stroke, 'pts' | 'size' | 'real' | 'shape'>, last = true): string {
  return outlineToPath(
    getStroke(s.pts, {
      size: s.size,
      // Gentle pressure response: S Pen pressure is noisy, and strong thinning
      // turns that noise into a rippled outline.
      thinning: s.shape ? 0 : s.real ? 0.35 : 0.5,
      smoothing: 0.62,
      streamline: s.real ? 0.5 : 0.4,
      simulatePressure: !s.real && !s.shape,
      last,
    }),
  );
}
export const fillFor = (color: string) => (color === 'auto' ? 'var(--ink)' : color);
const SVG_NS = 'http://www.w3.org/2000/svg';

function distToSegment(px: number, py: number, a: number[], b: number[]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function hits(s: Stroke, x: number, y: number, r: number) {
  const pts = s.pts;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) < r + s.size;
  for (let i = 0; i < pts.length - 1; i++) if (distToSegment(x, y, pts[i], pts[i + 1]) < r + s.size / 2) return true;
  return false;
}

// ---------------------------------------------------------------- palm rejection (page-wide)

let lastPenTime = 0;
let penDown = false;
const PEN_GRACE_MS = 700;
/** The pen is touching, or was seen (touching or hovering) in the last moment. */
export const penActive = () => penDown || Date.now() - lastPenTime < PEN_GRACE_MS;

const debugState = { type: '-', pressure: 0, buttons: 0, cancels: 0, hz: 0 };
let debugEl: HTMLElement | null = null;
function debug(e?: PointerEvent) {
  if (e) {
    debugState.type = e.pointerType;
    debugState.pressure = e.pressure;
    debugState.buttons = e.buttons;
  }
  if (debugEl)
    debugEl.textContent = `${debugState.type} p=${debugState.pressure.toFixed(2)} btn=${debugState.buttons} cancel=${debugState.cancels}${debugState.hz ? ` ${debugState.hz}Hz` : ''}`;
}

/** Raw samples of the last stroke, for tuning the smoothing on real S Pen data. */
let lastRaw: { t: number; x: number; y: number; p: number; tx: number; ty: number }[] = [];
export function downloadLastStroke() {
  const blob = new Blob([JSON.stringify({ ua: navigator.userAgent, samples: lastRaw })], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'pen-stroke.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

if (typeof document !== 'undefined') {
  // Track the pen anywhere on the page, hovering included. (Pen panning and
  // Android handwriting-to-text are prevented by touch-action: none on the
  // note area -- not by cancelling touch events, which would also swallow
  // the pen's clicks on buttons.)
  const markPen = (e: PointerEvent) => {
    if (e.pointerType === 'pen') lastPenTime = Date.now();
  };
  document.addEventListener('pointermove', markPen, { capture: true, passive: true });
  document.addEventListener('pointerdown', markPen, { capture: true, passive: true });
  // Swallow finger/palm touches that land while the pen is in use.
  let blockedUntil = 0;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch' && penActive()) {
        blockedUntil = Date.now() + 600;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true },
  );
  for (const type of ['mousedown', 'click'] as const) {
    document.addEventListener(
      type,
      (e) => {
        if (Date.now() < blockedUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true },
    );
  }
}

// ---------------------------------------------------------------- host + layer

/** Where the ink layer lives: the notebook element (unscaled page coordinates
 *  inside it) and its current visual scale. */
export interface InkHost {
  notebook: HTMLElement;
  scale(): number;
  /** Called after layout with the number of pages to show. */
  layout(pages: number): void;
}
export const inkHost = Facet.define<InkHost, InkHost | null>({ combine: (v) => v[0] ?? null });

/** Pages needed for the text and ink, given the user's page count. */
let shownPages = 1;
export const currentPages = () => shownPages;

class InkLayer implements PluginValue {
  host: InkHost | null;
  svg: SVGSVGElement;
  paths = new Map<string, { s: Stroke; el: SVGPathElement }>();
  drawId: number | null = null;
  erasing = false;
  live: { el: SVGPathElement; pts: [number, number, number][]; color: string; size: number; real: boolean; ps: number } | null = null;
  erased = new Set<string>();
  lastErase: [number, number] | null = null;
  lastT = 0;

  constructor(readonly view: EditorView) {
    this.host = view.state.facet(inkHost);
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('ink-layer');
    if (!this.host) return;
    this.host.notebook.appendChild(this.svg);
    const nb = this.host.notebook;
    nb.addEventListener('pointerdown', this.down, { capture: true });
    nb.addEventListener('pointermove', this.move, { capture: true });
    nb.addEventListener('pointerup', this.up, { capture: true });
    nb.addEventListener('pointercancel', this.cancel, { capture: true });
    this.render();
    this.scheduleLayout(true);
  }

  update(u: ViewUpdate) {
    const inkChanged = u.startState.field(inkField) !== u.state.field(inkField);
    if (inkChanged) this.render();
    if (inkChanged || u.docChanged || u.geometryChanged || u.heightChanged || u.startState.field(pagesField) !== u.state.field(pagesField))
      this.scheduleLayout(false);
  }

  destroy() {
    this.svg.remove();
    if (!this.host) return;
    const nb = this.host.notebook;
    nb.removeEventListener('pointerdown', this.down, { capture: true });
    nb.removeEventListener('pointermove', this.move, { capture: true });
    nb.removeEventListener('pointerup', this.up, { capture: true });
    nb.removeEventListener('pointercancel', this.cancel, { capture: true });
  }

  /** Work out the page count (and convert old-format strokes once). */
  scheduleLayout(convertLegacy: boolean) {
    this.view.requestMeasure({
      key: this,
      read: () => {
        const host = this.host!;
        const textBottom = this.view.dom.offsetTop + this.view.dom.offsetHeight + 48;
        const strokes = this.view.state.field(inkField);
        let inkBottom = 0;
        for (const s of strokes) for (const p of s.pts) if (p[1] > inkBottom) inkBottom = p[1];
        const pages = Math.max(this.view.state.field(pagesField), Math.ceil(textBottom / PAGE_H), Math.ceil((inkBottom + 24) / PAGE_H), 1);
        let converted: Stroke[] | null = null;
        if (convertLegacy && strokes.some((s) => s.anchor !== undefined)) {
          const base = host.notebook.getBoundingClientRect();
          const k = host.scale();
          converted = strokes.map((s) => {
            if (s.anchor === undefined) return s;
            const c = this.view.coordsAtPos(Math.min(s.anchor, this.view.state.doc.length), 1);
            const ax = c ? (c.left - base.left) / k : 0;
            const ay = c ? (c.top - base.top) / k : 0;
            return { id: s.id, color: s.color, size: s.size, real: s.real, pts: s.pts.map(([x, y, p]) => [x + ax, y + ay, p] as [number, number, number]) };
          });
        }
        return { pages, converted };
      },
      write: ({ pages, converted }) => {
        shownPages = pages;
        this.host!.layout(pages);
        // (dispatching inside the measure phase is not allowed)
        if (converted)
          setTimeout(() =>
            this.view.dispatch({
              effects: [removeStrokes.of(converted.map((s) => s.id)), addStrokes.of(converted)],
              annotations: Transaction.addToHistory.of(false),
            }),
          );
      },
    });
  }

  render() {
    const strokes = this.view.state.field(inkField);
    const keep = new Set<string>();
    for (const s of strokes) {
      keep.add(s.id);
      const cur = this.paths.get(s.id);
      if (cur && cur.s === s) continue;
      const el = cur?.el ?? (document.createElementNS(SVG_NS, 'path') as SVGPathElement);
      if (s.anchor !== undefined) el.style.display = 'none'; // waiting for conversion
      else el.style.display = '';
      el.setAttribute('d', strokePath(s));
      el.setAttribute('fill', fillFor(s.color));
      if (!cur) this.svg.appendChild(el);
      this.paths.set(s.id, { s, el });
    }
    for (const [id, { el }] of this.paths) {
      if (!keep.has(id)) {
        el.remove();
        this.paths.delete(id);
      }
    }
  }

  /** Pointer position in page coordinates. */
  local(e: PointerEvent): [number, number, number] {
    const r = this.host!.notebook.getBoundingClientRect();
    const k = this.host!.scale();
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k, e.pressure || 0.5];
  }

  down = (e: PointerEvent) => {
    debug(e);
    const isPen = e.pointerType === 'pen';
    const draws = isPen || (e.pointerType === 'mouse' && tool.mouseDraws && e.button === 0);
    if (!draws || this.drawId !== null) return; // fingers & normal mouse: text editing
    e.preventDefault(); // no caret move, no keyboard, no text selection
    e.stopPropagation();
    if (isPen) penDown = true;
    this.drawId = e.pointerId;
    try {
      this.host!.notebook.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events can't be captured */
    }
    // eraser tool, a pen's eraser end (buttons & 32), or the S Pen side button (buttons & 2)
    this.erasing = tool.mode === 'eraser' || (e.buttons & 32) !== 0 || (isPen && (e.buttons & 2) !== 0);
    const pt = this.local(e);
    lastRaw = [];
    this.lastT = e.timeStamp;
    this.record(e, pt);
    if (this.erasing) {
      this.erased.clear();
      this.lastErase = null;
      this.eraseAt(pt[0], pt[1]);
      return;
    }
    const el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('fill', fillFor(tool.color));
    this.svg.appendChild(el);
    this.live = { el, pts: [pt], color: tool.color, size: tool.size, real: isPen, ps: pt[2] };
    el.setAttribute('d', strokePath(this.live, false));
  };

  record(e: PointerEvent, pt: [number, number, number]) {
    lastRaw.push({ t: +e.timeStamp.toFixed(2), x: +pt[0].toFixed(2), y: +pt[1].toFixed(2), p: +e.pressure.toFixed(3), tx: e.tiltX, ty: e.tiltY });
  }

  /** Add a sample with light filtering: drop points closer than 0.8 px to the
   *  previous one (sub-pixel jitter) and low-pass the pressure. */
  addPoint(pt: [number, number, number]) {
    const live = this.live!;
    const last = live.pts[live.pts.length - 1];
    live.ps += 0.3 * (pt[2] - live.ps);
    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.8) return;
    live.pts.push([Math.round(pt[0] * 10) / 10, Math.round(pt[1] * 10) / 10, Math.round(live.ps * 100) / 100]);
  }

  move = (e: PointerEvent) => {
    if (e.pointerId !== this.drawId) return;
    e.preventDefault();
    e.stopPropagation();
    debug(e);
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const pt = this.local(ev);
      this.record(ev, pt);
      if (this.erasing) this.eraseAt(pt[0], pt[1]);
      else if (this.live) this.addPoint(pt);
    }
    if (this.live) this.live.el.setAttribute('d', strokePath(this.live, false));
  };

  up = (e: PointerEvent) => {
    if (e.pointerId !== this.drawId) return;
    e.preventDefault();
    e.stopPropagation();
    this.finish();
  };

  cancel = (e: PointerEvent) => {
    if (e.pointerId !== this.drawId) return;
    debugState.cancels++;
    this.finish(); // keep what was drawn so far
  };

  finish() {
    this.drawId = null;
    penDown = false;
    if (lastRaw.length > 2) {
      const dt = lastRaw[lastRaw.length - 1].t - lastRaw[0].t;
      debugState.hz = dt > 0 ? Math.round(((lastRaw.length - 1) * 1000) / dt) : 0;
    }
    debug();
    if (this.live) {
      const { el, pts, color, size, real } = this.live;
      this.live = null;
      el.remove();
      this.view.dispatch({ effects: addStrokes.of([{ id: newId(), pts, color, size, real }]) });
    } else if (this.erasing && this.erased.size) {
      this.view.dispatch({ effects: removeStrokes.of([...this.erased]) });
    }
  }

  eraseAt(x: number, y: number) {
    // Sample along the path since the last event so fast swipes don't skip strokes.
    const [x0, y0] = this.lastErase ?? [x, y];
    this.lastErase = [x, y];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / 4));
    for (const s of this.view.state.field(inkField)) {
      if (this.erased.has(s.id)) continue;
      for (let i = 0; i <= steps; i++) {
        if (hits(s, x0 + ((x - x0) * i) / steps, y0 + ((y - y0) * i) / steps, 6)) {
          this.erased.add(s.id);
          const el = this.paths.get(s.id)?.el;
          if (el) el.style.display = 'none';
          break;
        }
      }
    }
  }
}

const inkLayer = ViewPlugin.fromClass(InkLayer);

/** Editor extensions for ink, seeded with a note's strokes and page count. */
export function inkExtensions(strokes: Stroke[], pages: number, host: InkHost) {
  return [inkField.init(() => strokes), pagesField.init(() => Math.max(1, pages)), inkHistory, inkHost.of(host), inkLayer];
}

// ---------------------------------------------------------------- palette

/** The pen palette: tool, colour, size, mouse drawing, undo/redo. */
export function buildInkPalette(view: () => EditorView): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'palette';
  bar.setAttribute('role', 'toolbar');
  const group = () => bar.appendChild(Object.assign(document.createElement('div'), { className: 'group' }));
  const button = (parent: HTMLElement, html: string, title: string, onClick: () => void) => {
    const b = parent.appendChild(document.createElement('button'));
    b.className = 'icon-btn';
    b.innerHTML = html;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  };

  const tools = group();
  const pen = button(tools, icons.pen, 'Pen', () => setTool({ mode: 'pen' }));
  const eraser = button(tools, icons.eraser, 'Eraser (or hold the S Pen side button)', () => setTool({ mode: 'eraser' }));

  const colours = group();
  const swatches = COLORS.map((c) => {
    const b = button(colours, '<span class="dot"></span>', c.name, () => setTool({ color: c.value, mode: 'pen' }));
    b.classList.add('swatch');
    b.style.setProperty('--swatch', fillFor(c.value));
    return b;
  });

  const sizesG = group();
  const sizes = SIZES.map((sz) => {
    const b = button(sizesG, `<span class="dot" style="--d:${(sz * 1.6 + 3).toFixed(1)}px"></span>`, `Thickness ${sz}`, () =>
      setTool({ size: sz, mode: 'pen' }),
    );
    b.classList.add('size');
    return b;
  });

  const misc = group();
  const mouse = button(misc, icons.mouse, 'Draw with the mouse (the pen always draws)', () => setTool({ mouseDraws: !tool.mouseDraws }));
  mouse.classList.add('desktop-only');
  button(misc, icons.undo, 'Undo', () => {
    undo(view());
  });
  button(misc, icons.redo, 'Redo', () => {
    redo(view());
  });

  debugEl = bar.appendChild(document.createElement('button'));
  debugEl.className = 'pen-debug';
  debugEl.title = 'Pen test readout (pointer type, pressure, buttons, cancelled strokes, sample rate). Tap to download the last stroke’s raw samples.';
  debugEl.addEventListener('click', downloadLastStroke);
  debug();

  const sync = () => {
    pen.classList.toggle('on', tool.mode === 'pen');
    eraser.classList.toggle('on', tool.mode === 'eraser');
    mouse.classList.toggle('on', tool.mouseDraws);
    swatches.forEach((b, i) => b.classList.toggle('on', COLORS[i].value === tool.color));
    sizes.forEach((b, i) => b.classList.toggle('on', SIZES[i] === tool.size));
  };
  toolListeners.add(sync);
  sync();
  return bar;
}
