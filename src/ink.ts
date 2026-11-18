// Inline pen drawing ("ink blocks") inside the note.
//
// In the Markdown an ink block is a single line:   ![ink](ink/<id>.svg)
// CodeMirror replaces that line with a drawing surface (a block widget).
// The strokes themselves live outside the text, in the ink store keyed by id,
// so typing never touches them and the .md file stays readable.
//
// Input uses Pointer Events:
//   pen   -> draws, with real pressure (S Pen in Chrome on Android)
//   mouse -> draws, with simulated pressure
//   touch -> never draws; one finger scrolls. While the pen is in use (down or
//            hovering in the last moment) touches are ignored = palm rejection.
// S Pen side button or a pen's eraser end erases.

import { EditorState, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { getStroke } from 'perfect-freehand';

// ---------------------------------------------------------------- data

export interface Stroke {
  /** [x, y, pressure] in logical units (block is INK_WIDTH wide). */
  pts: [number, number, number][];
  color: string;
  size: number;
  /** true if pressure came from the device, false = simulate from speed. */
  real: boolean;
}

export interface InkData {
  id: string;
  noteId: string;
  strokes: Stroke[];
  height: number;
  updated: number;
}

export const INK_WIDTH = 1000;
const DEFAULT_HEIGHT = 400;
const MIN_HEIGHT = 120;

export const COLORS: { name: string; value: string }[] = [
  { name: 'Ink', value: 'auto' }, // black on light theme, white on dark
  { name: 'Red', value: '#e03131' },
  { name: 'Blue', value: '#1c7ed6' },
  { name: 'Green', value: '#2f9e44' },
];
export const SIZES = [3, 6, 12];

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// In-memory cache of ink blocks. Persistence is plugged in via setInkSaveHook.
const cache = new Map<string, InkData>();
let saveHook: (ink: InkData) => void = () => {};
let currentNoteId = '';

export function setInkSaveHook(f: (ink: InkData) => void) {
  saveHook = f;
}
export function setCurrentNote(id: string) {
  currentNoteId = id;
}
export function cacheInk(ink: InkData) {
  cache.set(ink.id, ink);
}
export function getInk(id: string): InkData {
  let ink = cache.get(id);
  if (!ink) {
    ink = { id, noteId: currentNoteId, strokes: [], height: DEFAULT_HEIGHT, updated: Date.now() };
    cache.set(id, ink);
  }
  return ink;
}
function saveInk(ink: InkData) {
  ink.updated = Date.now();
  saveHook(ink);
}

// ---------------------------------------------------------------- rendering

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

export function strokePath(s: Stroke, last = true): string {
  return outlineToPath(
    getStroke(s.pts, {
      size: s.size,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.4,
      simulatePressure: !s.real,
      last,
    }),
  );
}

function fillFor(color: string) {
  return color === 'auto' ? 'var(--fg)' : color;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function pathEl(s: Stroke, last = true) {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', strokePath(s, last));
  p.setAttribute('fill', fillFor(s.color));
  return p;
}

// ---------------------------------------------------------------- tool state

export const tool = {
  mode: 'pen' as 'pen' | 'eraser',
  color: 'auto',
  size: SIZES[1],
};
const toolListeners = new Set<() => void>();
export function setTool(patch: Partial<typeof tool>) {
  Object.assign(tool, patch);
  toolListeners.forEach((f) => f());
}
export function onToolChange(f: () => void) {
  toolListeners.add(f);
}

// ---------------------------------------------------------------- palm rejection

let lastPenTime = 0;
let penDown = false;
const PEN_GRACE_MS = 700;
export function penActive() {
  return penDown || Date.now() - lastPenTime < PEN_GRACE_MS;
}
let penTimer = 0;
function notePen() {
  lastPenTime = Date.now();
  document.body.classList.add('pen-active');
  clearTimeout(penTimer);
  penTimer = window.setTimeout(() => {
    if (!penDown) document.body.classList.remove('pen-active');
  }, PEN_GRACE_MS);
}

let debugEl: HTMLElement | null = null;
export function setPenDebugElement(el: HTMLElement) {
  debugEl = el;
}
function debug(e: PointerEvent) {
  if (debugEl) debugEl.textContent = `${e.pointerType} p=${e.pressure.toFixed(2)}`;
}

// Track the pen anywhere on the page (hover included) and swallow touches
// that land while the pen is active, so a resting palm can't move the cursor
// or open the keyboard.
if (typeof document !== 'undefined') {
  const markPen = (e: PointerEvent) => {
    if (e.pointerType === 'pen') notePen();
  };
  document.addEventListener('pointermove', markPen, { capture: true, passive: true });
  document.addEventListener('pointerdown', markPen, { capture: true, passive: true });
  let blockedTouchUntil = 0;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch' && penActive()) {
        blockedTouchUntil = Date.now() + 600;
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
        if (Date.now() < blockedTouchUntil) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      { capture: true },
    );
  }
}

function scrollParent(el: HTMLElement): HTMLElement {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return document.scrollingElement as HTMLElement;
}

// ---------------------------------------------------------------- the block

function distToSegment(px: number, py: number, a: number[], b: number[]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function hitsStroke(s: Stroke, x: number, y: number, r: number) {
  const pts = s.pts;
  if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) < r + s.size;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distToSegment(x, y, pts[i], pts[i + 1]) < r + s.size / 2) return true;
  }
  return false;
}

function buildBlock(id: string, view: EditorView): HTMLElement {
  const ink = getInk(id);
  const wrap = document.createElement('div');
  wrap.className = 'ink-block';

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('ink-surface');
  const g = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(g);
  wrap.appendChild(svg);

  const del = document.createElement('button');
  del.className = 'ink-delete';
  del.title = 'Delete drawing';
  del.textContent = '✕';
  wrap.appendChild(del);

  const handle = document.createElement('div');
  handle.className = 'ink-resize';
  handle.title = 'Drag to resize';
  wrap.appendChild(handle);

  const setSize = () => {
    svg.setAttribute('viewBox', `0 0 ${INK_WIDTH} ${ink.height}`);
    svg.style.aspectRatio = `${INK_WIDTH} / ${ink.height}`;
    view.requestMeasure();
  };
  const redraw = () => {
    g.replaceChildren(...ink.strokes.map((s) => pathEl(s)));
  };
  setSize();
  redraw();
  const syncCursor = () => wrap.classList.toggle('erasing', tool.mode === 'eraser');
  syncCursor();
  onToolChange(syncCursor);

  const toLogical = (e: PointerEvent): [number, number, number] => {
    const r = svg.getBoundingClientRect();
    const k = INK_WIDTH / r.width;
    const x = Math.round((e.clientX - r.left) * k * 10) / 10;
    const y = Math.round((e.clientY - r.top) * k * 10) / 10;
    return [x, y, Math.round((e.pressure || 0.5) * 100) / 100];
  };

  let drawId: number | null = null;
  let erasing = false;
  let current: Stroke | null = null;
  let live: SVGPathElement | null = null;
  let eraseChanged = false;
  let finger: { id: number; y: number; scroller: HTMLElement } | null = null;

  let lastErase: [number, number] | null = null;
  const eraseAt = (x: number, y: number) => {
    // Sample along the path since the last event so fast swipes don't skip strokes.
    const [x0, y0] = lastErase ?? [x, y];
    lastErase = [x, y];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / 6));
    const samples = Array.from({ length: steps + 1 }, (_, i) => [x0 + ((x - x0) * i) / steps, y0 + ((y - y0) * i) / steps]);
    const before = ink.strokes.length;
    ink.strokes = ink.strokes.filter((s) => !samples.some(([sx, sy]) => hitsStroke(s, sx, sy, 10)));
    if (ink.strokes.length !== before) {
      eraseChanged = true;
      redraw();
    }
  };

  svg.addEventListener('pointerdown', (e) => {
    debug(e);
    if (e.pointerType === 'touch') {
      // Fingers scroll (touch-action is off on the canvas, so we do it by hand).
      if (!penActive() && !finger) finger = { id: e.pointerId, y: e.clientY, scroller: scrollParent(wrap) };
      return;
    }
    if (drawId !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    if (e.pointerType === 'pen') penDown = true;
    drawId = e.pointerId;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events can't be captured */
    }
    // eraser tool, pen eraser end (buttons & 32) or S Pen side button (buttons & 2)
    erasing = tool.mode === 'eraser' || (e.buttons & 32) !== 0 || (e.pointerType === 'pen' && (e.buttons & 2) !== 0);
    const pt = toLogical(e);
    if (erasing) {
      eraseChanged = false;
      lastErase = null;
      eraseAt(pt[0], pt[1]);
    } else {
      current = { pts: [pt], color: tool.color, size: tool.size, real: e.pointerType === 'pen' };
      live = pathEl(current, false);
      g.appendChild(live);
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (finger && e.pointerId === finger.id) {
      if (penActive()) {
        finger = null;
        return;
      }
      finger.scroller.scrollTop -= e.clientY - finger.y;
      finger.y = e.clientY;
      return;
    }
    if (e.pointerId !== drawId) return;
    debug(e);
    const events = e.getCoalescedEvents?.() ?? [e];
    for (const ev of events.length ? events : [e]) {
      const pt = toLogical(ev);
      if (erasing) eraseAt(pt[0], pt[1]);
      else current?.pts.push(pt);
    }
    if (current && live) live.setAttribute('d', strokePath(current, false));
  });

  const end = (e: PointerEvent) => {
    if (finger && e.pointerId === finger.id) finger = null;
    if (e.pointerId !== drawId) return;
    drawId = null;
    penDown = false;
    if (current && live) {
      ink.strokes.push(current);
      live.setAttribute('d', strokePath(current, true));
      // Auto-grow when writing near the bottom edge.
      const maxY = Math.max(...current.pts.map((p) => p[1]));
      if (maxY > ink.height - 60) {
        ink.height += 200;
        setSize();
      }
      saveInk(ink);
    } else if (erasing && eraseChanged) {
      saveInk(ink);
    }
    current = null;
    live = null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);

  // Resize handle: drag with anything (finger included).
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = ink.height;
    const k = INK_WIDTH / svg.getBoundingClientRect().width;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const move = (ev: PointerEvent) => {
      ink.height = Math.max(MIN_HEIGHT, Math.round(startH + (ev.clientY - startY) * k));
      setSize();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      saveInk(ink);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  del.addEventListener('click', () => {
    if (ink.strokes.length && !confirm('Delete this drawing?')) return;
    removeInkLine(view, id);
  });

  (wrap as HTMLElement & { _cleanup?: () => void })._cleanup = () => toolListeners.delete(syncCursor);
  return wrap;
}

// ---------------------------------------------------------------- CodeMirror glue

export const INK_LINE = /^!\[ink\]\(ink\/([A-Za-z0-9_-]+)\.svg\)\s*$/;
export const inkMarker = (id: string) => `![ink](ink/${id}.svg)`;

/** Ink ids referenced by a note body. */
export function inkIdsIn(text: string): string[] {
  return text
    .split('\n')
    .map((l) => INK_LINE.exec(l)?.[1])
    .filter((x): x is string => !!x);
}

class InkWidget extends WidgetType {
  constructor(readonly id: string) {
    super();
  }
  eq(o: InkWidget) {
    return o.id === this.id;
  }
  toDOM(view: EditorView) {
    return buildBlock(this.id, view);
  }
  destroy(dom: HTMLElement) {
    (dom as HTMLElement & { _cleanup?: () => void })._cleanup?.();
  }
  ignoreEvent() {
    return true; // the canvas handles its own pointer events
  }
  get estimatedHeight() {
    return 350;
  }
}

function buildInkDecorations(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!line.text.startsWith('![ink]')) continue;
    const m = INK_LINE.exec(line.text);
    if (m) decos.push(Decoration.replace({ widget: new InkWidget(m[1]), block: true }).range(line.from, line.to));
  }
  return Decoration.set(decos);
}

export const inkField = StateField.define<DecorationSet>({
  create: buildInkDecorations,
  update(deco, tr) {
    return tr.docChanged ? buildInkDecorations(tr.state) : deco;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
});

/** Insert a new, empty ink block below the cursor's line. */
export function insertInk(view: EditorView) {
  const id = newId();
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const before = line.text.trim() ? '\n\n' : line.number > 1 ? '\n' : '';
  const text = before + inkMarker(id) + '\n\n';
  view.dispatch({
    changes: { from: line.to, insert: text },
    selection: { anchor: line.to + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

function removeInkLine(view: EditorView, id: string) {
  const doc = view.state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (INK_LINE.exec(line.text)?.[1] === id) {
      const to = n < doc.lines ? line.to + 1 : line.to;
      view.dispatch({ changes: { from: line.from, to } });
      return;
    }
  }
}

// ---------------------------------------------------------------- toolbar

export function buildInkToolbar(onInsert: () => void): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'ink-toolbar';
  const add = (el: HTMLElement) => (bar.appendChild(el), el);

  const ins = add(document.createElement('button'));
  ins.textContent = '✎ Draw';
  ins.title = 'Insert a drawing below the cursor';
  ins.addEventListener('click', onInsert);

  const pen = add(document.createElement('button'));
  pen.textContent = 'Pen';
  pen.addEventListener('click', () => setTool({ mode: 'pen' }));
  const eraser = add(document.createElement('button'));
  eraser.textContent = 'Eraser';
  eraser.addEventListener('click', () => setTool({ mode: 'eraser' }));

  const swatches = COLORS.map((c) => {
    const b = add(document.createElement('button'));
    b.className = 'swatch';
    b.title = c.name;
    b.style.setProperty('--swatch', fillFor(c.value));
    b.addEventListener('click', () => setTool({ color: c.value, mode: 'pen' }));
    return b;
  });
  const sizes = SIZES.map((s) => {
    const b = add(document.createElement('button'));
    b.className = 'size';
    b.title = `Size ${s}`;
    b.innerHTML = `<span style="width:${s + 2}px;height:${s + 2}px"></span>`;
    b.addEventListener('click', () => setTool({ size: s, mode: 'pen' }));
    return b;
  });
  const dbg = add(document.createElement('span'));
  dbg.className = 'pen-debug';
  dbg.title = 'Last pointer type and pressure';
  setPenDebugElement(dbg);

  const sync = () => {
    pen.classList.toggle('on', tool.mode === 'pen');
    eraser.classList.toggle('on', tool.mode === 'eraser');
    swatches.forEach((b, i) => b.classList.toggle('on', COLORS[i].value === tool.color));
    sizes.forEach((b, i) => b.classList.toggle('on', SIZES[i] === tool.size));
  };
  onToolChange(sync);
  sync();
  return bar;
}
