// Pen ink drawn directly over the note text (circle an equation, underline,
// sketch in the margin or in the blank space below).
//
// How it stays attached to the text: each stroke stores an *anchor* -- the
// document position of the character under the stroke's centre -- and its
// points as offsets (CSS px) from that character's on-screen position.
//  * Edits move anchors with the text (CodeMirror maps positions through
//    every change), so typing above a circle doesn't detach it.
//  * Window size / device changes reflow the text; the stroke follows its
//    anchor character to its new place.
//  * Deleting the text under a stroke deletes the stroke; undo brings both back.
//  * Strokes are part of editor state, so Ctrl/Cmd+Z undoes drawing too.
//
// Input (Pointer Events):
//   pen   -> always draws (real pressure, e.g. S Pen in Chrome on Android)
//   mouse -> draws only when "Draw mode" is on; otherwise edits text
//   touch -> never draws: scrolls and places the cursor. While the pen is in
//            use (touching or hovering), touches are ignored = palm rejection.
// The S Pen side button or a pen's eraser end erases.

import { MapMode, StateEffect, StateField } from '@codemirror/state';
import { EditorView, PluginValue, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { invertedEffects } from '@codemirror/commands';
import { getStroke } from 'perfect-freehand';

// ---------------------------------------------------------------- data

export interface Stroke {
  id: string;
  /** Document position this stroke is attached to. */
  anchor: number;
  /** [dx, dy, pressure], CSS px relative to the anchor character's top-left. */
  pts: [number, number, number][];
  color: string;
  size: number;
  /** true = pressure from the device; false = simulate from speed (mouse). */
  real: boolean;
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

const mapStrokes = (ss: Stroke[], m: { mapPos(p: number, assoc?: number): number }) =>
  ss.map((s) => ({ ...s, anchor: m.mapPos(s.anchor, 1) }));

export const addStrokes = StateEffect.define<Stroke[]>({ map: mapStrokes });
export const removeStrokes = StateEffect.define<string[]>();

export const inkField = StateField.define<Stroke[]>({
  create: () => [],
  update(strokes, tr) {
    if (tr.docChanged) {
      const next: Stroke[] = [];
      for (const s of strokes) {
        const a = tr.changes.mapPos(s.anchor, 1, MapMode.TrackDel);
        if (a !== null) next.push(a === s.anchor ? s : { ...s, anchor: a });
      }
      strokes = next;
    }
    for (const e of tr.effects) {
      if (e.is(addStrokes)) strokes = [...strokes, ...e.value];
      else if (e.is(removeStrokes)) {
        const ids = new Set(e.value);
        strokes = strokes.filter((s) => !ids.has(s.id));
      }
    }
    return strokes;
  },
});

/** Make ink part of undo/redo: record the inverse of whatever changed. */
const inkHistory = invertedEffects.of((tr) => {
  const before = tr.startState.field(inkField, false);
  const after = tr.state.field(inkField, false);
  if (!before || !after || before === after) return [];
  const afterIds = new Set(after.map((s) => s.id));
  const beforeIds = new Set(before.map((s) => s.id));
  const out: StateEffect<unknown>[] = [];
  const added = after.filter((s) => !beforeIds.has(s.id)).map((s) => s.id);
  const removed = before.filter((s) => !afterIds.has(s.id));
  if (added.length) out.push(removeStrokes.of(added));
  if (removed.length) out.push(addStrokes.of(removed));
  return out;
});

// ---------------------------------------------------------------- tool state

export const tool = {
  mode: 'pen' as 'pen' | 'eraser',
  color: 'auto',
  size: SIZES[1],
  /** Let the mouse draw (the pen always draws). */
  mouseDraws: false,
};
const toolListeners = new Set<() => void>();
export function setTool(patch: Partial<typeof tool>) {
  Object.assign(tool, patch);
  document.body.classList.toggle('mouse-draws', tool.mouseDraws);
  document.body.classList.toggle('erasing', tool.mode === 'eraser');
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

export function strokePath(s: Pick<Stroke, 'pts' | 'size' | 'real'>, last = true): string {
  return outlineToPath(
    getStroke(s.pts, { size: s.size, thinning: 0.6, smoothing: 0.5, streamline: 0.4, simulatePressure: !s.real, last }),
  );
}
const fillFor = (color: string) => (color === 'auto' ? 'var(--fg)' : color);
const SVG_NS = 'http://www.w3.org/2000/svg';

function distToSegment(px: number, py: number, a: number[], b: number[]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function hits(pts: Stroke['pts'], size: number, ox: number, oy: number, x: number, y: number, r: number) {
  x -= ox;
  y -= oy;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) < r + size;
  for (let i = 0; i < pts.length - 1; i++) if (distToSegment(x, y, pts[i], pts[i + 1]) < r + size / 2) return true;
  return false;
}

// ---------------------------------------------------------------- palm rejection (page-wide)

let lastPenTime = 0;
let penDown = false;
const PEN_GRACE_MS = 700;
const penActive = () => penDown || Date.now() - lastPenTime < PEN_GRACE_MS;
let penTimer = 0;
function notePen() {
  lastPenTime = Date.now();
  // While the pen is near, the page stops native touch scrolling, so the pen
  // (and a resting palm) can't scroll it. See .pen-active in style.css.
  document.body.classList.add('pen-active');
  clearTimeout(penTimer);
  penTimer = window.setTimeout(() => {
    if (!penDown) document.body.classList.remove('pen-active');
  }, PEN_GRACE_MS);
}

const debugState = { type: '-', pressure: 0, buttons: 0, cancels: 0 };
let debugEl: HTMLElement | null = null;
function debug(e?: PointerEvent) {
  if (e) {
    debugState.type = e.pointerType;
    debugState.pressure = e.pressure;
    debugState.buttons = e.buttons;
  }
  if (debugEl) debugEl.textContent = `${debugState.type} p=${debugState.pressure.toFixed(2)} btn=${debugState.buttons} cancel=${debugState.cancels}`;
}

if (typeof document !== 'undefined') {
  const markPen = (e: PointerEvent) => {
    if (e.pointerType === 'pen') notePen();
  };
  document.addEventListener('pointermove', markPen, { capture: true, passive: true });
  document.addEventListener('pointerdown', markPen, { capture: true, passive: true });
  // Stylus contact also produces touch events in Chrome. The pen's
  // pointerdown (above) fires first and marks the pen active, so cancelling
  // touchstart here stops the pen -- or a palm landing while the pen is in
  // use -- from scrolling the page or starting stylus handwriting.
  document.addEventListener(
    'touchstart',
    (e) => {
      if (penActive()) e.preventDefault();
    },
    { capture: true, passive: false },
  );
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

// ---------------------------------------------------------------- the overlay

class InkOverlay implements PluginValue {
  svg: SVGSVGElement;
  paths = new Map<string, SVGPathElement>();
  /** Where each stroke's anchor currently is, relative to view.dom. */
  placed = new Map<string, { x: number; y: number }>();
  drawId: number | null = null;
  erasing = false;
  live: { el: SVGPathElement; pts: [number, number, number][]; color: string; size: number; real: boolean } | null = null;
  erased = new Set<string>();
  lastErase: [number, number] | null = null;

  constructor(readonly view: EditorView) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('ink-overlay');
    view.dom.appendChild(this.svg);
    const opts = { capture: true };
    view.dom.addEventListener('pointerdown', this.down, opts);
    view.dom.addEventListener('pointermove', this.move, opts);
    view.dom.addEventListener('pointerup', this.up, opts);
    view.dom.addEventListener('pointercancel', this.cancel, opts);
    this.schedule();
  }

  update(u: ViewUpdate) {
    if (
      u.docChanged ||
      u.viewportChanged ||
      u.geometryChanged ||
      u.heightChanged ||
      u.selectionSet || // the formula under the cursor switches between rendered and source
      u.startState.field(inkField) !== u.state.field(inkField)
    )
      this.schedule();
  }

  destroy() {
    this.svg.remove();
    const opts = { capture: true };
    this.view.dom.removeEventListener('pointerdown', this.down, opts);
    this.view.dom.removeEventListener('pointermove', this.move, opts);
    this.view.dom.removeEventListener('pointerup', this.up, opts);
    this.view.dom.removeEventListener('pointercancel', this.cancel, opts);
  }

  schedule() {
    this.view.requestMeasure({ key: this, read: () => this.measure(), write: (m) => this.apply(m) });
  }

  /** Layout read phase: where is each anchor on screen? */
  measure() {
    const base = this.view.dom.getBoundingClientRect();
    const pos = new Map<string, { x: number; y: number }>();
    for (const s of this.view.state.field(inkField)) {
      const c = this.view.coordsAtPos(s.anchor, 1) ?? this.view.coordsAtPos(s.anchor, -1);
      if (c) pos.set(s.id, { x: c.left - base.left, y: c.top - base.top });
    }
    return pos;
  }

  /** DOM write phase: create/move/remove <path>s. */
  apply(pos: Map<string, { x: number; y: number }>) {
    const strokes = this.view.state.field(inkField);
    const keep = new Set<string>();
    for (const s of strokes) {
      keep.add(s.id);
      let el = this.paths.get(s.id);
      if (!el) {
        el = document.createElementNS(SVG_NS, 'path');
        el.setAttribute('d', strokePath(s));
        el.setAttribute('fill', fillFor(s.color));
        this.svg.appendChild(el);
        this.paths.set(s.id, el);
      }
      const p = pos.get(s.id);
      if (p) {
        el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
        el.style.display = '';
      } else el.style.display = 'none'; // anchor scrolled out of the rendered range
    }
    for (const [id, el] of this.paths) {
      if (!keep.has(id)) {
        el.remove();
        this.paths.delete(id);
      }
    }
    this.placed = pos;
  }

  local(e: PointerEvent): [number, number, number] {
    const r = this.view.dom.getBoundingClientRect();
    return [
      Math.round((e.clientX - r.left) * 10) / 10,
      Math.round((e.clientY - r.top) * 10) / 10,
      Math.round((e.pressure || 0.5) * 100) / 100,
    ];
  }

  down = (e: PointerEvent) => {
    debug(e);
    const isPen = e.pointerType === 'pen';
    const draws = isPen || (e.pointerType === 'mouse' && tool.mouseDraws && e.button === 0);
    if (!draws || this.drawId !== null) return; // fingers & normal mouse: regular text editing
    e.preventDefault(); // no caret move, no keyboard, no text selection
    e.stopPropagation();
    if (isPen) penDown = true;
    this.drawId = e.pointerId;
    try {
      this.view.dom.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events can't be captured */
    }
    // eraser tool, a pen's eraser end (buttons & 32), or the S Pen side button (buttons & 2)
    this.erasing = tool.mode === 'eraser' || (e.buttons & 32) !== 0 || (isPen && (e.buttons & 2) !== 0);
    const pt = this.local(e);
    if (this.erasing) {
      this.erased.clear();
      this.lastErase = null;
      this.eraseAt(pt[0], pt[1]);
    } else {
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('fill', fillFor(tool.color));
      this.svg.appendChild(el);
      this.live = { el, pts: [pt], color: tool.color, size: tool.size, real: isPen };
      el.setAttribute('d', strokePath(this.live, false));
    }
  };

  move = (e: PointerEvent) => {
    if (e.pointerId !== this.drawId) return;
    e.preventDefault();
    e.stopPropagation();
    debug(e);
    const events = e.getCoalescedEvents?.() ?? [];
    for (const ev of events.length ? events : [e]) {
      const pt = this.local(ev);
      if (this.erasing) this.eraseAt(pt[0], pt[1]);
      else this.live?.pts.push(pt);
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
    debug();
    this.finish(); // keep what was drawn so far
  };

  finish() {
    this.drawId = null;
    penDown = false;
    if (this.live) {
      const { el, pts, color, size, real } = this.live;
      this.live = null;
      el.remove();
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      const base = this.view.dom.getBoundingClientRect();
      const anchor = this.view.posAtCoords({ x: base.left + cx, y: base.top + cy }, false);
      const c = this.view.coordsAtPos(anchor, 1) ?? this.view.coordsAtPos(anchor, -1);
      const ax = c ? c.left - base.left : 0;
      const ay = c ? c.top - base.top : 0;
      const rel = pts.map(([x, y, p]) => [Math.round((x - ax) * 10) / 10, Math.round((y - ay) * 10) / 10, p] as [number, number, number]);
      this.view.dispatch({ effects: addStrokes.of([{ id: newId(), anchor, pts: rel, color, size, real }]) });
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
      const at = this.placed.get(s.id);
      if (!at || this.erased.has(s.id)) continue;
      for (let i = 0; i <= steps; i++) {
        const sx = x0 + ((x - x0) * i) / steps;
        const sy = y0 + ((y - y0) * i) / steps;
        if (hits(s.pts, s.size, at.x, at.y, sx, sy, 6)) {
          this.erased.add(s.id);
          const el = this.paths.get(s.id);
          if (el) el.style.display = 'none';
          break;
        }
      }
    }
  }
}

const inkOverlay = ViewPlugin.fromClass(InkOverlay);

/** Editor extensions for ink, seeded with a note's saved strokes. */
export function inkExtensions(strokes: Stroke[]) {
  return [inkField.init(() => strokes), inkHistory, inkOverlay];
}

// ---------------------------------------------------------------- toolbar

export function buildInkToolbar(): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'ink-toolbar';
  const add = <T extends HTMLElement>(el: T) => (bar.appendChild(el), el);
  const button = (text: string, title: string, onClick: () => void) => {
    const b = add(document.createElement('button'));
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };

  const mouse = button('🖱 Draw mode', 'Let the mouse draw (the pen always draws)', () =>
    setTool({ mouseDraws: !tool.mouseDraws }),
  );
  const pen = button('Pen', 'Pen', () => setTool({ mode: 'pen' }));
  const eraser = button('Eraser', 'Erase whole strokes (or hold the S Pen button)', () => setTool({ mode: 'eraser' }));
  const swatches = COLORS.map((c) => {
    const b = button('', c.name, () => setTool({ color: c.value, mode: 'pen' }));
    b.className = 'swatch';
    b.style.setProperty('--swatch', fillFor(c.value));
    return b;
  });
  const sizes = SIZES.map((s) => {
    const b = button('', `Size ${s}`, () => setTool({ size: s, mode: 'pen' }));
    b.className = 'size';
    b.innerHTML = `<span style="width:${s * 1.5 + 2}px;height:${s * 1.5 + 2}px"></span>`;
    return b;
  });
  debugEl = add(document.createElement('span'));
  debugEl.className = 'pen-debug';
  debugEl.title = 'Last pointer type, pressure, buttons held, and cancelled strokes (for testing the S Pen)';
  debug();

  const sync = () => {
    mouse.classList.toggle('on', tool.mouseDraws);
    pen.classList.toggle('on', tool.mode === 'pen');
    eraser.classList.toggle('on', tool.mode === 'eraser');
    swatches.forEach((b, i) => b.classList.toggle('on', COLORS[i].value === tool.color));
    sizes.forEach((b, i) => b.classList.toggle('on', SIZES[i] === tool.size));
  };
  toolListeners.add(sync);
  sync();
  return bar;
}
