// Run with: node tests/shapes.test.ts   (Node 23+ runs TypeScript directly)
// Noisy synthetic strokes -> expected recognised shape.
import { recognize, type Pt } from '../src/shapes.ts';

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const jitter = (pts: Pt[], amp: number): Pt[] => pts.map(([x, y]) => [x + rand() * amp, y + rand() * amp]);
const lineTo = (a: Pt, b: Pt, n = 30): Pt[] => Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / (n - 1), a[1] + ((b[1] - a[1]) * i) / (n - 1)]);
const poly = (vs: Pt[]) => vs.slice(1).flatMap((v, i) => lineTo(vs[i], v).slice(i ? 1 : 0));
const ellipse = (cx: number, cy: number, a: number, b: number, rot = 0, sweep = 2.05 * Math.PI): Pt[] =>
  Array.from({ length: 90 }, (_, i) => {
    const t = (sweep * i) / 89;
    const [u, v] = [a * Math.cos(t), b * Math.sin(t)];
    return [cx + u * Math.cos(rot) - v * Math.sin(rot), cy + u * Math.sin(rot) + v * Math.cos(rot)];
  });

const cases: [string, Pt[], string | null][] = [
  ['straight line', jitter(lineTo([10, 10], [300, 60], 60), 2), 'line'],
  ['circle', jitter(ellipse(200, 200, 80, 80), 3), 'circle'],
  ['wide ellipse', jitter(ellipse(200, 200, 150, 60), 3), 'ellipse'],
  ['tilted ellipse', jitter(ellipse(200, 200, 140, 55, 0.6), 3), 'ellipse'],
  ['rectangle', jitter(poly([[50, 50], [350, 50], [350, 200], [50, 200], [52, 55]]), 3), 'rectangle'],
  ['tilted rectangle', jitter(poly([[100, 50], [300, 150], [250, 250], [50, 150], [98, 55]]), 3), 'rectangle'],
  ['triangle', jitter(poly([[200, 40], [340, 280], [60, 280], [196, 46]]), 3), 'triangle'],
  ['angle (2 segments)', jitter(poly([[40, 40], [200, 240], [360, 60]]), 2), 'polyline'],
  ['scribble', jitter(Array.from({ length: 120 }, (_, i) => [i * 3, 100 + 60 * Math.sin(i / 3) * Math.cos(i / 11)] as Pt), 2), null],
  ['tiny dot', jitter(lineTo([10, 10], [14, 12], 8), 0.5), null],
];

let fail = 0;
for (const [name, pts, want] of cases) {
  const got = recognize(pts)?.kind ?? null;
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${got}, want ${want}`);
}
process.exit(fail ? 1 : 0);
