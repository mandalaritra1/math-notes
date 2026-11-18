// Shape recognition for "hold to snap": draw a rough shape, keep the pen still
// for a moment at the end, and it is replaced by a clean line, polyline,
// circle, ellipse, rectangle, triangle or polygon. Pure functions, no DOM.

export type Pt = [number, number];
export type ShapeKind = 'line' | 'polyline' | 'circle' | 'ellipse' | 'rectangle' | 'triangle' | 'polygon';
export interface Shape {
  kind: ShapeKind;
  /** Points to draw, already densified; closed shapes repeat the first point. */
  pts: Pt[];
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distToLine(p: Pt, a: Pt, b: Pt) {
  const l = dist(a, b);
  if (l === 0) return dist(p, a);
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / l;
}

/** Ramer-Douglas-Peucker simplification. */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToLine(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const left = simplify(pts.slice(0, idx + 1), eps);
  const right = simplify(pts.slice(idx), eps);
  return [...left.slice(0, -1), ...right];
}

function pathLength(pts: Pt[]) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Resample a polyline so points are at most `step` apart (keeps corners). */
function densify(vertices: Pt[], step = 5): Pt[] {
  const out: Pt[] = [vertices[0]];
  for (let i = 1; i < vertices.length; i++) {
    const [a, b] = [vertices[i - 1], vertices[i]];
    const n = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Interior angle at vertex b, in degrees. */
function angleAt(a: Pt, b: Pt, c: Pt) {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(v1[0], v1[1]) * Math.hypot(v2[0], v2[1]) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** Principal-axis ellipse fit; returns the ellipse and its mean relative error. */
function fitEllipse(pts: Pt[]) {
  const n = pts.length;
  const cx = pts.reduce((s, p) => s + p[0], 0) / n;
  const cy = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - cx) ** 2;
    syy += (y - cy) ** 2;
    sxy += (x - cx) * (y - cy);
  }
  sxx /= n;
  syy /= n;
  sxy /= n;
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const [c, s] = [Math.cos(theta), Math.sin(theta)];
  // Radii from the extent along each principal axis (robust to uneven sampling).
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const [x, y] of pts) {
    const u = (x - cx) * c + (y - cy) * s;
    const v = -(x - cx) * s + (y - cy) * c;
    umin = Math.min(umin, u);
    umax = Math.max(umax, u);
    vmin = Math.min(vmin, v);
    vmax = Math.max(vmax, v);
  }
  const a = (umax - umin) / 2;
  const b = (vmax - vmin) / 2;
  const ucx = (umax + umin) / 2;
  const vcx = (vmax + vmin) / 2;
  const ecx = cx + ucx * c - vcx * s;
  const ecy = cy + ucx * s + vcx * c;
  let err = 0;
  for (const [x, y] of pts) {
    const u = (x - ecx) * c + (y - ecy) * s;
    const v = -(x - ecx) * s + (y - ecy) * c;
    err += Math.abs(Math.hypot(u / (a || 1), v / (b || 1)) - 1);
  }
  return { cx: ecx, cy: ecy, a, b, theta, err: err / n };
}

function ellipsePoints(cx: number, cy: number, a: number, b: number, theta: number): Pt[] {
  const n = Math.max(48, Math.round((2 * Math.PI * Math.max(a, b)) / 5));
  const [c, s] = [Math.cos(theta), Math.sin(theta)];
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    const u = a * Math.cos(t);
    const v = b * Math.sin(t);
    out.push([cx + u * c - v * s, cy + u * s + v * c]);
  }
  return out;
}

/** Recognise a hand-drawn shape, or return null to leave the stroke as drawn. */
export function recognize(raw: Pt[]): Shape | null {
  if (raw.length < 6) return null;
  const xs = raw.map((p) => p[0]);
  const ys = raw.map((p) => p[1]);
  const D = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (D < 16) return null;
  const L = pathLength(raw);
  const first = raw[0];
  const last = raw[raw.length - 1];
  const closed = dist(first, last) < Math.max(0.18 * D, 12) && L > 1.5 * D;

  if (!closed) {
    const chord = dist(first, last);
    let maxDev = 0;
    for (const p of raw) maxDev = Math.max(maxDev, distToLine(p, first, last));
    if (chord > 0.85 * L && maxDev < Math.max(0.06 * chord, 4)) return { kind: 'line', pts: densify([first, last]) };
    const simple = simplify(raw, Math.max(0.06 * D, 4));
    if (simple.length <= 4) return { kind: 'polyline', pts: densify(simple) };
    return null;
  }

  // Closed: corners first (a polygon has a few sharp turns), else an ellipse.
  const loop = [...raw, first];
  let corners = simplify(loop, Math.max(0.07 * D, 5));
  if (dist(corners[0], corners[corners.length - 1]) < Math.max(0.18 * D, 12)) corners = corners.slice(0, -1);
  // The start point is usually not a real corner: drop near-straight vertices.
  const sharp = corners.filter((p, i) => angleAt(corners[(i - 1 + corners.length) % corners.length], p, corners[(i + 1) % corners.length]) < 150);
  const ell = fitEllipse(raw);

  if (sharp.length === 3) return { kind: 'triangle', pts: densify([...sharp, sharp[0]]) };
  if (sharp.length === 4) {
    const angles = sharp.map((p, i) => angleAt(sharp[(i + 3) % 4], p, sharp[(i + 1) % 4]));
    if (angles.every((a) => Math.abs(a - 90) < 20)) {
      // Rectangle: keep its orientation (principal axis), square the corners.
      const { cx, cy, theta } = ell;
      const [c, s] = [Math.cos(theta), Math.sin(theta)];
      const us = raw.map(([x, y]) => (x - cx) * c + (y - cy) * s);
      const vs = raw.map(([x, y]) => -(x - cx) * s + (y - cy) * c);
      const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
      // Snap to axis-aligned if it is close.
      const tilt = Math.abs(((theta * 180) / Math.PI + 360) % 90);
      const toXY = (u: number, v: number): Pt => [cx + u * c - v * s, cy + u * s + v * c];
      if (tilt < 8 || tilt > 82) {
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        return { kind: 'rectangle', pts: densify([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]) };
      }
      const r = [toXY(u0, v0), toXY(u1, v0), toXY(u1, v1), toXY(u0, v1)];
      return { kind: 'rectangle', pts: densify([...r, r[0]]) };
    }
    return { kind: 'polygon', pts: densify([...sharp, sharp[0]]) };
  }
  if (ell.err < 0.11) {
    if (Math.min(ell.a, ell.b) / Math.max(ell.a, ell.b) > 0.85) {
      const r = (ell.a + ell.b) / 2;
      return { kind: 'circle', pts: ellipsePoints(ell.cx, ell.cy, r, r, 0) };
    }
    return { kind: 'ellipse', pts: ellipsePoints(ell.cx, ell.cy, ell.a, ell.b, ell.theta) };
  }
  if (sharp.length >= 5 && sharp.length <= 8) return { kind: 'polygon', pts: densify([...sharp, sharp[0]]) };
  return null;
}
