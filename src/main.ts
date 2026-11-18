import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-400-italic.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-ext-400.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { EditorView } from '@codemirror/view';
import { createEditor, loadDoc, EditorOptions } from './editor';
import { buildInkPalette, currentPages, inkExtensions, inkField, newId, PAGE_H, PAGE_W, pagesField, penActive, setPages } from './ink';
import type { InkHost } from './ink';
import { enableFingerScroll } from './touchscroll';
import { icons } from './icons';
import * as db from './db';
import type { Note } from './db';
import * as drive from './sync';
import { applyNotebookTheme, loadPrefs, PAGE_COLORS, PATTERNS, savePrefs, TEXT_THEMES, type Prefs } from './theme';
import { popover, setScribbleErase } from './ink';

const WELCOME = `# Welcome to Math Notes

Inline math like $E = mc^2$ or $\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt\\pi}{2}$ renders as you type.
Click a formula to edit its source.

$$
\\mathcal{L} = -\\frac14 F_{\\mu\\nu}F^{\\mu\\nu} + \\bar\\psi(i\\gamma^\\mu D_\\mu - m)\\psi
$$

This is an A4 notebook: write anywhere on the page with the pen, around and over the text.
Need more room? Use **Add page** at the bottom.
On a computer, turn on the arrow button in the pen toolbar to draw with the mouse. Undo works for ink too.
`;

// ------------------------------------------------------------------ layout

const app = document.getElementById('app')!;
app.innerHTML = `
  <aside class="sidebar">
    <div class="side-head">
      <span class="brand"><span class="brand-mark">∫</span> Math Notes</span>
      <span class="side-actions">
        <button class="icon-btn primary" id="new-note" title="New note" aria-label="New note">${icons.plus}</button>
        <button class="icon-btn" id="close-side" title="Hide notes" aria-label="Hide notes">${icons.sidebar}</button>
      </span>
    </div>
    <label class="search">${icons.search}<input type="search" id="search" placeholder="Search notes or #tag" /></label>
    <label class="field">${icons.folder}<select id="folder-filter"></select></label>
    <div id="tag-cloud" class="tag-cloud"></div>
    <ul id="note-list" class="note-list"></ul>
    <div class="side-foot">
      <button id="sync-btn" class="sync-btn" title="Sign in to Google (first time) and sync">${icons.sync}<span>Sync with Drive</span></button>
      <div id="sync-status" class="status"></div>
      <details id="drive-settings">
        <summary>${icons.settings}<span>Drive settings</span></summary>
        <label class="stack">Google OAuth client ID
          <input type="text" id="client-id" placeholder="1234-abc.apps.googleusercontent.com" />
        </label>
        <button id="sign-out" class="small-btn">Sign out of Google</button>
      </details>
    </div>
  </aside>
  <div class="scrim" id="scrim"></div>
  <div class="main">
    <header class="topbar">
      <button class="icon-btn" id="toggle-side" title="Show notes" aria-label="Show notes">${icons.menu}</button>
      <label class="chip" title="Folder">${icons.folder}<input type="text" id="note-folder" list="folder-options" placeholder="No folder" /></label>
      <label class="chip grow" title="Tags, comma separated">${icons.tag}<input type="text" id="note-tags" placeholder="Add tags" /></label>
      <datalist id="folder-options"></datalist>
      <span class="spacer"></span>
      <span class="status" id="save-status"></span>
      <button class="icon-btn" id="appearance" title="Page and text style" aria-label="Page and text style">${icons.palette}</button>
      <button class="icon-btn" id="export-pdf" title="Export PDF" aria-label="Export PDF">${icons.file}</button>
      <button class="icon-btn danger" id="delete-note" title="Delete note" aria-label="Delete note">${icons.trash}</button>
    </header>
    <div class="toolrow"></div>
    <div class="editor-scroll">
      <div class="notebook-frame">
        <div class="notebook">
          <div class="pages"></div>
          <div class="editor-host"></div>
        </div>
      </div>
      <div class="add-page-row"><button class="small-btn" id="add-page">${icons.plus}<span>Add page</span></button></div>
    </div>
  </div>`;

const $ = <T extends HTMLElement>(sel: string) => app.querySelector(sel) as T;
const searchEl = $<HTMLInputElement>('#search');
const folderFilterEl = $<HTMLSelectElement>('#folder-filter');
const tagCloudEl = $('#tag-cloud');
const listEl = $('#note-list');
const folderEl = $<HTMLInputElement>('#note-folder');
const tagsEl = $<HTMLInputElement>('#note-tags');
const statusEl = $('#save-status');

// ------------------------------------------------------------------ state

let notes: Note[] = [];
let current: Note | null = null;
let activeTag = '';
let saveTimer = 0;
/** The open note has edits not yet written to IndexedDB. */
let unsaved = false;
/** Sync replaced the open note while it had unsaved edits (see flushSave). */
let pulledUnderEdit = false;

const editorOpts: EditorOptions = {
  onChange(state) {
    if (!current) return;
    current.body = state.doc.toString();
    current.ink = state.field(inkField);
    current.pages = state.field(pagesField);
    scheduleSave();
  },
};

// ------------------------------------------------------------------ notebook (A4 pages, scaled to fit)

const scrollEl = $('.editor-scroll');
const frameEl = $('.notebook-frame');
const notebookEl = $('.notebook');
const pagesEl = $('.pages');
let scale = 1;
let pageCount = 1;

function applyLayout() {
  frameEl.style.width = `${PAGE_W * scale}px`;
  frameEl.style.height = `${PAGE_H * pageCount * scale}px`;
  notebookEl.style.height = `${PAGE_H * pageCount}px`;
  notebookEl.style.transform = `scale(${scale})`;
}
const inkHostImpl: InkHost = {
  notebook: notebookEl,
  scale: () => scale,
  layout(pages) {
    if (pages !== pageCount || pagesEl.childElementCount !== pages) {
      pageCount = pages;
      pagesEl.replaceChildren(
        ...Array.from({ length: pages }, (_, i) => {
          const p = document.createElement('div');
          p.className = 'page';
          p.style.top = `${i * PAGE_H}px`;
          p.dataset.n = `${i + 1} / ${pages}`;
          return p;
        }),
      );
    }
    applyLayout();
  },
};
// Fit the page width to the screen (never wider than 1.25x).
new ResizeObserver(() => {
  const avail = scrollEl.clientWidth - (scrollEl.clientWidth < 700 ? 12 : 48);
  const next = Math.min(1.25, avail / PAGE_W);
  if (Math.abs(next - scale) > 0.001) {
    scale = next;
    applyLayout();
    view.requestMeasure();
  }
}).observe(scrollEl);

const ink = (n: { ink?: Note['ink']; pages?: number }) => inkExtensions(n.ink ?? [], n.pages ?? 1, inkHostImpl);
const view: EditorView = createEditor($('.editor-host'), '', editorOpts, ink({}));

// ------------------------------------------------------------------ appearance (page colour, pattern, text theme)

let prefs: Prefs = loadPrefs();
const applyTheme = (forceLight = false) => applyNotebookTheme(notebookEl, prefs, forceLight);
applyTheme();
setScribbleErase(prefs.scribble);
// Follow the system theme -- but not while printing: print media flips
// prefers-color-scheme, which would undo the PDF's light paper mid-print.
let printLight: boolean | null = null;
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(printLight ?? false));

function setPref(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  savePrefs(prefs);
  applyTheme();
  setScribbleErase(prefs.scribble);
}

$('#appearance').addEventListener('click', (e) =>
  popover(e.currentTarget as HTMLElement, () => {
    const panel = Object.assign(document.createElement('div'), { className: 'appearance' });
    const section = (title: string) => {
      const h = panel.appendChild(document.createElement('div'));
      h.className = 'pop-title';
      h.textContent = title;
      return panel.appendChild(Object.assign(document.createElement('div'), { className: 'pop-row' }));
    };
    const tone = notebookEl.dataset.tone as 'light' | 'dark';
    const rerender = () => {
      panel.replaceChildren();
      build();
    };
    const build = () => {
      const pages = section('Page colour');
      for (const pc of PAGE_COLORS) {
        const b = pages.appendChild(document.createElement('button'));
        b.className = 'page-swatch' + (prefs.page === pc.id ? ' on' : '');
        b.title = pc.name;
        b.setAttribute('aria-label', pc.name);
        b.style.background = pc.color ?? 'linear-gradient(135deg, #ffffff 50%, #1d1f24 50%)';
        b.addEventListener('click', () => (setPref({ page: pc.id }), rerender()));
      }
      const pats = section('Page pattern');
      for (const pt of PATTERNS) {
        const b = pats.appendChild(document.createElement('button'));
        b.className = 'chip-btn' + (prefs.pattern === pt.id ? ' on' : '');
        b.textContent = pt.name;
        b.addEventListener('click', () => (setPref({ pattern: pt.id }), rerender()));
      }
      const texts = section('Text style');
      texts.classList.add('themes');
      for (const th of TEXT_THEMES) {
        const b = texts.appendChild(document.createElement('button'));
        b.className = 'theme-btn' + (prefs.text === th.id ? ' on' : '');
        const tn = (notebookEl.dataset.tone as 'light' | 'dark') ?? tone;
        b.innerHTML = `<span class="aa" style="color:${th.h1[tn]};font-family:${th.font ?? 'inherit'}">Aa</span><span class="name">${th.name}</span><span class="dots"><i style="background:${th.h2[tn]}"></i><i style="background:${th.code[tn]}"></i></span>`;
        b.style.setProperty('--sheet-preview', getComputedStyle(notebookEl).getPropertyValue('--sheet'));
        b.addEventListener('click', () => (setPref({ text: th.id }), rerender()));
      }
      const pen = section('Pen');
      const tog = pen.appendChild(document.createElement('label'));
      tog.className = 'toggle';
      tog.innerHTML = `<input type="checkbox" ${prefs.scribble ? 'checked' : ''}/><span>Scribble over ink to erase it<small>Scratch back and forth across a drawing. Undo brings it back. (The S Pen button can't be read by web apps.)</small></span>`;
      tog.querySelector('input')!.addEventListener('change', (ev) => setPref({ scribble: (ev.target as HTMLInputElement).checked }));
    };
    build();
    return panel;
  }),
);

// ------------------------------------------------------------------ PDF export (via the browser's print → Save as PDF)

function exportPdf(light: boolean) {
  const oldTitle = document.title;
  document.title = current ? db.noteTitle(current.body) : 'Math Notes';
  printLight = light;
  // Park the cursor at the very start and blur, so no formula or Markdown
  // mark is shown as source in the PDF; restored afterwards.
  const sel = view.state.selection;
  view.dispatch({ selection: { anchor: 0 } });
  view.contentDOM.blur();
  applyTheme(light);
  notebookEl.style.setProperty('--pages', String(currentPages()));
  document.body.classList.add('printing');
  const done = () => {
    printLight = null;
    document.body.classList.remove('printing');
    view.dispatch({ selection: sel });
    document.title = oldTitle;
    applyTheme();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 60);
}
$('#export-pdf').addEventListener('click', (e) =>
  popover(e.currentTarget as HTMLElement, (close) => {
    const panel = Object.assign(document.createElement('div'), { className: 'export' });
    panel.innerHTML = `<div class="pop-title">Export PDF</div>
      <button class="menu-btn" data-light="1"><b>Light paper</b><span>White pages, dark ink: best for printing and sharing</span></button>
      <button class="menu-btn" data-light="0"><b>As shown</b><span>Your page colour and theme</span></button>
      <div class="pop-note">Opens the print dialog: choose “Save as PDF”.</div>`;
    panel.querySelectorAll<HTMLButtonElement>('.menu-btn').forEach((b) =>
      b.addEventListener('click', () => {
        close();
        exportPdf(b.dataset.light === '1');
      }),
    );
    return panel;
  }),
);
$('.toolrow').appendChild(buildInkPalette(() => view));
enableFingerScroll(scrollEl, penActive);

$('#add-page').addEventListener('click', () => {
  view.dispatch({ effects: setPages.of(currentPages() + 1) });
  setTimeout(() => scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' }), 50);
});
// Clicking blank page space below the text puts the cursor at the end.
notebookEl.addEventListener('click', (e) => {
  if ((e.target as Element).closest('.cm-editor')) return;
  view.focus();
  view.dispatch({ selection: { anchor: view.state.doc.length } });
});

function setStatus(s: string) {
  statusEl.textContent = s;
}

function scheduleSave() {
  unsaved = true;
  setStatus('Editing…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!current || !unsaved) return;
  unsaved = false;
  await db.saveNote(current);
  if (pulledUnderEdit) {
    pulledUnderEdit = false;
    await db.markRemoteUnknown(current.id);
  }
  if (!notes.some((n) => n.id === current!.id)) {
    notes.push(current);
    renderFilters();
  }
  setStatus('Saved');
  renderList();
  scheduleAutoSync();
}

// ------------------------------------------------------------------ notes

export async function openNote(id: string) {
  if (current) await flushSave();
  const note = await db.getNote(id);
  if (!note || note.deleted) return;
  current = note;
  note.ink ??= [];
  note.pages ??= 1;
  loadDoc(view, note.body, editorOpts, ink(note));
  scrollEl.scrollTop = 0;
  folderEl.value = note.folder;
  tagsEl.value = note.tags.join(', ');
  await db.setMeta('lastNote', note.id);
  setStatus('');
  renderList();
  closeSidebarOnMobile();
}

async function newNote(body = '# ') {
  const n: Note = {
    id: newId(),
    body,
    folder: folderFilterEl.value && folderFilterEl.value !== '\u0000' ? folderFilterEl.value : '',
    tags: activeTag ? [activeTag] : [],
    ink: [],
    pages: 1,
    created: Date.now(),
    updated: Date.now(),
    dirty: true,
  };
  await db.saveNote(n);
  notes = await db.allNotes();
  await openNote(n.id);
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  view.focus();
}

$('#new-note').addEventListener('click', () => void newNote());

$('#delete-note').addEventListener('click', async () => {
  if (!current || !confirm(`Delete “${db.noteTitle(current.body)}”?`)) return;
  clearTimeout(saveTimer);
  unsaved = false;
  await db.deleteNote(current.id);
  current = null;
  await refresh();
});

const parseTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];

folderEl.addEventListener('change', () => {
  if (!current) return;
  current.folder = folderEl.value.trim();
  unsaved = true;
  void flushSave().then(renderFilters);
});
tagsEl.addEventListener('change', () => {
  if (!current) return;
  current.tags = parseTags(tagsEl.value);
  tagsEl.value = current.tags.join(', ');
  unsaved = true;
  void flushSave().then(renderFilters);
});

// ------------------------------------------------------------------ list, search, filters

function matches(n: Note): boolean {
  const folder = folderFilterEl.value;
  if (folder === '\u0000' ? n.folder !== '' : folder && n.folder !== folder) return false;
  if (activeTag && !n.tags.includes(activeTag)) return false;
  const hay = (n.body + ' ' + n.folder).toLowerCase();
  for (const term of searchEl.value.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (term.startsWith('#') && term.length > 1) {
      if (!n.tags.some((t) => t.toLowerCase().startsWith(term.slice(1)))) return false;
    } else if (!hay.includes(term)) return false;
  }
  return true;
}

function snippet(body: string) {
  const lines = body.split('\n').filter((l) => l.trim());
  return (lines[1] ?? '').replace(/[#*_`>$]/g, '').slice(0, 90);
}

function renderList() {
  if (current) notes = notes.map((n) => (n.id === current!.id ? current! : n));
  const shown = notes.filter(matches).sort((a, b) => b.updated - a.updated);
  if (!notes.length) return void (listEl.innerHTML = '<li class="empty">No notes yet. Start typing, or press + New.</li>');
  listEl.replaceChildren(
    ...shown.map((n) => {
      const li = document.createElement('li');
      li.className = n.id === current?.id ? 'active' : '';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = db.noteTitle(n.body);
      const sub = document.createElement('div');
      sub.className = 'sub';
      const date = new Date(n.updated).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      sub.textContent = [date, n.folder && `📁 ${n.folder}`, ...n.tags.map((t) => '#' + t)].filter(Boolean).join('  ');
      const snip = document.createElement('div');
      snip.className = 'snip';
      snip.textContent = snippet(n.body);
      li.append(title, snip, sub);
      li.addEventListener('click', () => void openNote(n.id));
      return li;
    }),
  );
  if (!shown.length) listEl.innerHTML = '<li class="empty">No notes match.</li>';
}

function renderFilters() {
  const folders = [...new Set(notes.map((n) => n.folder).filter(Boolean))].sort();
  const sel = folderFilterEl.value;
  folderFilterEl.innerHTML =
    '<option value="">All folders</option><option value="\u0000">(no folder)</option>' +
    folders.map((f) => `<option>${escapeHtml(f)}</option>`).join('');
  folderFilterEl.value = folders.includes(sel) || sel === '\u0000' ? sel : '';
  $('#folder-options').innerHTML = folders.map((f) => `<option value="${escapeHtml(f)}">`).join('');

  const tags = [...new Set(notes.flatMap((n) => n.tags))].sort();
  if (activeTag && !tags.includes(activeTag)) activeTag = '';
  tagCloudEl.replaceChildren(
    ...tags.map((t) => {
      const b = document.createElement('button');
      b.className = 'tag' + (t === activeTag ? ' on' : '');
      b.textContent = '#' + t;
      b.addEventListener('click', () => {
        activeTag = activeTag === t ? '' : t;
        renderFilters();
        renderList();
      });
      return b;
    }),
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

searchEl.addEventListener('input', renderList);
folderFilterEl.addEventListener('change', renderList);

// ------------------------------------------------------------------ sidebar on small screens

// Below 1000px (phones, portrait tablets) the notes list is a drawer over the
// page; wider, it is a panel that can be hidden. The choice is remembered.
const drawerMode = window.matchMedia('(max-width: 1000px)');
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
if (store.get('sideCollapsed') === '1') document.body.classList.add('side-collapsed');
function setSidebar(open: boolean) {
  if (drawerMode.matches) document.body.classList.toggle('side-open', open);
  else {
    document.body.classList.toggle('side-collapsed', !open);
    store.set('sideCollapsed', open ? '0' : '1');
  }
}
$('#toggle-side').addEventListener('click', () => setSidebar(true));
$('#close-side').addEventListener('click', () => setSidebar(false));
$('#scrim').addEventListener('click', () => setSidebar(false));
drawerMode.addEventListener('change', () => document.body.classList.remove('side-open'));
function closeSidebarOnMobile() {
  document.body.classList.remove('side-open');
}

// ------------------------------------------------------------------ Google Drive sync

const syncStatusEl = $('#sync-status');
const clientIdEl = $<HTMLInputElement>('#client-id');
let clientId = '';
let autoTimer = 0;

async function loadClientId() {
  clientId = (await db.getMeta<string>('clientId')) || import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
  clientIdEl.value = clientId;
  if (clientId && navigator.onLine) drive.loadGis().catch(() => {}); // preload so the sign-in pop-up opens instantly
}
clientIdEl.addEventListener('change', async () => {
  clientId = clientIdEl.value.trim();
  await db.setMeta('clientId', clientId);
  if (clientId) drive.loadGis().catch(() => {});
});
$('#sign-out').addEventListener('click', () => {
  drive.signOut();
  syncStatusEl.textContent = 'Signed out';
});

async function showLastSync() {
  const t = await db.getMeta<number>('lastSync');
  syncStatusEl.textContent = t ? `Last sync ${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet';
}

/** interactive = started by a click, so the Google sign-in pop-up is allowed. */
async function runSync(interactive: boolean) {
  if (!clientId) {
    ($('#drive-settings') as HTMLDetailsElement).open = true;
    syncStatusEl.textContent = 'Paste your OAuth client ID first';
    return;
  }
  if (!navigator.onLine) {
    syncStatusEl.textContent = 'Offline: will sync later';
    return;
  }
  let token = drive.currentToken();
  try {
    if (!token) {
      if (!interactive) return; // needs a click to sign in again
      token = await drive.getToken(clientId);
    }
    syncStatusEl.textContent = 'Syncing…';
    await flushSave();
    const r = await drive.sync(token);
    await refresh(r.pulled);
    await showLastSync();
    const parts = [r.up && `↑${r.up}`, r.down && `↓${r.down}`, r.deleted && `✕${r.deleted}`, r.conflicts && `${r.conflicts} conflict copy`];
    if (parts.some(Boolean)) syncStatusEl.textContent += ` (${parts.filter(Boolean).join(' ')})`;
  } catch (e) {
    syncStatusEl.textContent = `Sync failed: ${(e as Error).message}`;
    console.error(e);
  }
}

function scheduleAutoSync() {
  if (!drive.currentToken()) return;
  clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => void runSync(false), 5000);
}

$('#sync-btn').addEventListener('click', () => void runSync(true));
window.addEventListener('online', () => void runSync(false));
setInterval(() => void runSync(false), 3 * 60 * 1000);

// ------------------------------------------------------------------ startup

/** Reload everything from IndexedDB. After a sync, `pulled` lists notes that came from Drive. */
export async function refresh(pulled: string[] = []) {
  notes = await db.allNotes();
  if (!notes.length) {
    // Show the welcome text without saving it, so a fresh device that is about
    // to sync doesn't upload a duplicate. It becomes a real note once edited.
    renderFilters();
    if (!current) {
      current = { id: newId(), body: WELCOME, folder: '', tags: [], ink: [], pages: 1, created: Date.now(), updated: Date.now(), dirty: true };
      loadDoc(view, current.body, editorOpts, ink(current));
    }
    renderList();
    return;
  }
  renderFilters();
  const want = current?.id ?? (await db.getMeta<string>('lastNote'));
  const target = notes.find((n) => n.id === want) ?? [...notes].sort((a, b) => b.updated - a.updated)[0];
  if (current && current.id === target.id) {
    // Same note still open: pick up remote changes only if we have no unsaved edits.
    const fresh = await db.getNote(target.id);
    if (fresh && pulled.includes(fresh.id) && unsaved) pulledUnderEdit = true;
    if (fresh && pulled.includes(fresh.id) && !unsaved) {
      current = null;
      await openNote(target.id);
    }
    renderList();
  } else {
    current = null;
    await openNote(target.id);
  }
}

// Save before the tab is hidden or closed (Android may kill backgrounded tabs).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void flushSave();
});

// Offline support: the service worker caches the app; updates install silently.
registerSW({ immediate: true });
void navigator.storage?.persist?.();
void refresh()
  .then(loadClientId)
  .then(showLastSync)
  .then(() => runSync(false));

// Handy in the browser console during development: __view.state.field(...)
if (import.meta.env.DEV) Object.assign(window, { __view: view, __inkField: inkField, __pagesField: pagesField });
