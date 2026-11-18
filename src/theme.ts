// Notebook appearance: page colour + pattern, ink colours, and the text theme.
//
// Every page colour has a tone (light or dark paper). The tone, not the app's
// light/dark mode, decides the text colour and which variant of each ink and
// heading colour is used, so ink always contrasts with the paper: on white
// paper "Ink" is near-black and red is a deep red; on dark paper "Ink" is
// near-white and red is a lighter coral. Strokes store a colour *name*, so the
// same drawing re-colours itself on other paper (and in a light PDF export).

export type Tone = 'light' | 'dark';
type Pair = { light: string; dark: string };

export interface PageColor {
  id: string;
  name: string;
  /** null = follow the app's light/dark mode */
  color: string | null;
  tone: Tone | null;
}
export const PAGE_COLORS: PageColor[] = [
  { id: 'auto', name: 'Match app', color: null, tone: null },
  { id: 'white', name: 'White', color: '#ffffff', tone: 'light' },
  { id: 'ivory', name: 'Ivory', color: '#fbf7ec', tone: 'light' },
  { id: 'sky', name: 'Sky', color: '#eef4fb', tone: 'light' },
  { id: 'sage', name: 'Sage', color: '#eef5ef', tone: 'light' },
  { id: 'graphite', name: 'Graphite', color: '#26292f', tone: 'dark' },
  { id: 'navy', name: 'Navy', color: '#18202f', tone: 'dark' },
  { id: 'black', name: 'Black', color: '#0e0f11', tone: 'dark' },
];
const AUTO_PAGE: Pair = { light: '#ffffff', dark: '#1d1f24' };

export const PATTERNS = [
  { id: 'blank', name: 'Blank' },
  { id: 'lines', name: 'Lines' },
  { id: 'grid', name: 'Grid' },
  { id: 'dots', name: 'Dots' },
] as const;

/** Ink colours: a name and its light-paper / dark-paper variants (checked
 *  for contrast against both kinds of paper). */
export const INKS: { id: string; name: string; light: string; dark: string }[] = [
  { id: 'ink', name: 'Ink', light: '#1c1d21', dark: '#eceef2' },
  { id: 'grey', name: 'Grey', light: '#6b7079', dark: '#a3a9b4' },
  { id: 'red', name: 'Red', light: '#d42b2b', dark: '#ff7272' },
  { id: 'orange', name: 'Orange', light: '#e05a0c', dark: '#ffa14a' },
  { id: 'amber', name: 'Amber', light: '#b07d00', dark: '#ffd43b' },
  { id: 'green', name: 'Green', light: '#23883c', dark: '#6ee08a' },
  { id: 'teal', name: 'Teal', light: '#0b8193', dark: '#4fd6e8' },
  { id: 'blue', name: 'Blue', light: '#1d5fd6', dark: '#7aaeff' },
  { id: 'violet', name: 'Violet', light: '#6c43e0', dark: '#b8a0ff' },
  { id: 'pink', name: 'Pink', light: '#cf2f6e', dark: '#ff8fbd' },
];
/** Colours saved by older versions (hex values) -> names. */
const LEGACY: Record<string, string> = { auto: 'ink', '#e03131': 'red', '#1c7ed6': 'blue', '#2f9e44': 'green' };
export const inkId = (c: string) => LEGACY[c] ?? c;
/** CSS fill for a stored stroke colour. */
export function inkFill(c: string) {
  const id = inkId(c);
  return INKS.some((i) => i.id === id) ? `var(--ink-${id})` : c;
}

/** Text themes: heading / emphasis / code colours (+ heading font). */
export interface TextTheme {
  id: string;
  name: string;
  font?: string;
  h1: Pair;
  h2: Pair;
  h3: Pair;
  strong: Pair;
  code: Pair;
  link: Pair;
}
const TEXT: Pair = { light: '#1f2328', dark: '#e6e8ec' };
export const TEXT_THEMES: TextTheme[] = [
  { id: 'classic', name: 'Classic', h1: TEXT, h2: TEXT, h3: TEXT, strong: TEXT, code: { light: '#b4235a', dark: '#f39ac0' }, link: { light: '#1d5fd6', dark: '#7aaeff' } },
  {
    id: 'ocean', name: 'Ocean',
    h1: { light: '#1747b8', dark: '#8ab4ff' }, h2: { light: '#1f63d8', dark: '#9fc4ff' }, h3: { light: '#0b7285', dark: '#66d9e8' },
    strong: { light: '#16357a', dark: '#cfe0ff' }, code: { light: '#0b7a6e', dark: '#63e6be' }, link: { light: '#1f63d8', dark: '#9fc4ff' },
  },
  {
    id: 'ember', name: 'Ember',
    h1: { light: '#c2410c', dark: '#ffa36b' }, h2: { light: '#b45309', dark: '#ffc266' }, h3: { light: '#9f3a12', dark: '#ffb98a' },
    strong: { light: '#7c2d12', dark: '#ffe0c2' }, code: { light: '#be123c', dark: '#ffa3b8' }, link: { light: '#c2410c', dark: '#ffa36b' },
  },
  {
    id: 'forest', name: 'Forest',
    h1: { light: '#18753a', dark: '#7ee2a0' }, h2: { light: '#1f6b47', dark: '#8fe3b4' }, h3: { light: '#0f766e', dark: '#5fe0cf' },
    strong: { light: '#14532d', dark: '#c6f6d5' }, code: { light: '#9a6200', dark: '#ffd166' }, link: { light: '#0f766e', dark: '#5fe0cf' },
  },
  {
    id: 'scholar', name: 'Scholar', font: 'KaTeX_Main, Georgia, serif',
    h1: { light: '#7a1f1f', dark: '#ffaaa5' }, h2: { light: '#1e3a5f', dark: '#a9c9ff' }, h3: TEXT,
    strong: TEXT, code: { light: '#6b2fd6', dark: '#c9b6ff' }, link: { light: '#1e3a5f', dark: '#a9c9ff' },
  },
  {
    id: 'violet', name: 'Violet',
    h1: { light: '#6d28d9', dark: '#c4b5fd' }, h2: { light: '#7c3aed', dark: '#d6c2ff' }, h3: { light: '#a21caf', dark: '#f0abfc' },
    strong: { light: '#4c1d95', dark: '#e9e0ff' }, code: { light: '#be185d', dark: '#f9a8d4' }, link: { light: '#7c3aed', dark: '#d6c2ff' },
  },
];

export interface Prefs {
  page: string;
  pattern: string;
  text: string;
}
const DEFAULTS: Prefs = { page: 'auto', pattern: 'blank', text: 'classic' };
const KEY = 'mn-appearance';
export function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: keep for this session only */
  }
}

const appIsDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** Set the notebook's CSS variables. `forceLight` = white paper (PDF export). */
export function applyNotebookTheme(el: HTMLElement, prefs: Prefs, forceLight = false) {
  const page = PAGE_COLORS.find((p) => p.id === prefs.page) ?? PAGE_COLORS[0];
  let tone: Tone = page.tone ?? (appIsDark() ? 'dark' : 'light');
  let sheet = page.color ?? AUTO_PAGE[tone];
  if (forceLight) {
    tone = 'light';
    sheet = '#ffffff';
  }
  const theme = TEXT_THEMES.find((t) => t.id === prefs.text) ?? TEXT_THEMES[0];
  const v = (pair: Pair) => pair[tone];
  const vars: Record<string, string> = {
    '--sheet': sheet,
    '--text': v(TEXT),
    '--text-muted': tone === 'light' ? '#6b6f78' : '#9aa0aa',
    '--rule': tone === 'light' ? 'rgba(40, 70, 130, 0.14)' : 'rgba(200, 215, 240, 0.11)',
    '--page-sel': tone === 'light' ? 'rgba(59, 91, 219, 0.2)' : 'rgba(138, 164, 255, 0.28)',
    '--page-soft': tone === 'light' ? 'rgba(59, 91, 219, 0.07)' : 'rgba(138, 164, 255, 0.1)',
    '--page-sep': tone === 'light' ? 'rgba(0, 0, 0, 0.14)' : 'rgba(255, 255, 255, 0.14)',
    '--md-h1': v(theme.h1),
    '--md-h2': v(theme.h2),
    '--md-h3': v(theme.h3),
    '--md-strong': v(theme.strong),
    '--md-em': v(TEXT),
    '--md-code': v(theme.code),
    '--md-link': v(theme.link),
    '--md-quote': tone === 'light' ? '#5f6470' : '#a4aab5',
    '--md-mark': tone === 'light' ? '#a2a6ae' : '#6c727d',
    '--md-heading-font': theme.font ?? 'inherit',
  };
  for (const ink of INKS) vars[`--ink-${ink.id}`] = ink[tone];
  for (const [k, val] of Object.entries(vars)) el.style.setProperty(k, val);
  // The toolbar and colour picker sit outside the notebook: give them the inks too.
  if (!forceLight) for (const ink of INKS) document.documentElement.style.setProperty(`--ink-${ink.id}`, ink[tone]);
  el.dataset.tone = tone;
  el.dataset.pattern = prefs.pattern;
}
