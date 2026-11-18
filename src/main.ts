import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { EditorView } from '@codemirror/view';
import { createEditor, loadDoc, EditorOptions } from './editor';
import { buildInkToolbar, inkExtensions, inkField, newId } from './ink';
import * as db from './db';
import type { Note } from './db';
import * as drive from './sync';

const WELCOME = `# Welcome to Math Notes

Inline math like $E = mc^2$ or $\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt\\pi}{2}$ renders as you type.
Click a formula to edit its source.

$$
\\mathcal{L} = -\\frac14 F_{\\mu\\nu}F^{\\mu\\nu} + \\bar\\psi(i\\gamma^\\mu D_\\mu - m)\\psi
$$

Write on top of anything with the pen: circle an equation, underline, sketch in the space below.
On a computer, turn on **🖱 Draw mode** to draw with the mouse. Ctrl/Cmd+Z undoes ink too.
Set a folder and tags above.
`;

// ------------------------------------------------------------------ layout

const app = document.getElementById('app')!;
app.innerHTML = `
  <aside class="sidebar">
    <div class="side-head">
      <strong>Notes</strong><span class="spacer"></span>
      <button class="primary" id="new-note">+ New</button>
    </div>
    <input type="search" id="search" placeholder="Search…  (#tag to filter)" />
    <select id="folder-filter"></select>
    <div id="tag-cloud" class="tag-cloud"></div>
    <ul id="note-list" class="note-list"></ul>
    <div class="side-foot">
      <div class="sync-row">
        <button id="sync-btn" title="Sign in to Google (first time) and sync">⟳ Sync with Drive</button>
        <span id="sync-status" class="status"></span>
      </div>
      <details id="drive-settings">
        <summary>Drive settings</summary>
        <label>Google OAuth client ID
          <input type="text" id="client-id" placeholder="1234-abc.apps.googleusercontent.com" />
        </label>
        <button id="sign-out">Sign out of Google</button>
      </details>
    </div>
  </aside>
  <div class="main">
    <div class="topbar">
      <button id="toggle-side" title="Show notes">☰</button>
      <input type="text" id="note-folder" list="folder-options" placeholder="Folder" size="12" />
      <input type="text" id="note-tags" placeholder="tags, comma separated" size="18" />
      <datalist id="folder-options"></datalist>
      <span class="spacer"></span>
      <span class="status" id="save-status"></span>
      <button id="delete-note" title="Delete note">🗑</button>
    </div>
    <div class="topbar tools" id="tools"></div>
    <div class="editor-scroll"><div class="editor-host"></div></div>
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

const editorOpts: EditorOptions = {
  onChange(state) {
    if (!current) return;
    current.body = state.doc.toString();
    current.ink = state.field(inkField);
    scheduleSave();
  },
};
const view: EditorView = createEditor($('.editor-host'), '', editorOpts, inkExtensions([]));
$('#tools').appendChild(buildInkToolbar());

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
  loadDoc(view, note.body, editorOpts, inkExtensions(note.ink));
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

$('#toggle-side').addEventListener('click', () => document.body.classList.toggle('side-open'));
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
      current = { id: newId(), body: WELCOME, folder: '', tags: [], ink: [], created: Date.now(), updated: Date.now(), dirty: true };
      loadDoc(view, current.body, editorOpts, inkExtensions([]));
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
if (import.meta.env.DEV) Object.assign(window, { __view: view, __inkField: inkField });
