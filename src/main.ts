import './style.css';
import { EditorView } from '@codemirror/view';
import { createEditor, loadDoc, EditorOptions } from './editor';
import { buildInkToolbar, cacheInk, inkField, insertInk, newId, setCurrentNote, setInkSaveHook } from './ink';
import * as db from './db';
import type { Note } from './db';

const WELCOME = `# Welcome to Math Notes

Inline math like $E = mc^2$ or $\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt\\pi}{2}$ renders as you type.
Click a formula to edit its source.

$$
\\mathcal{L} = -\\frac14 F_{\\mu\\nu}F^{\\mu\\nu} + \\bar\\psi(i\\gamma^\\mu D_\\mu - m)\\psi
$$

Press **✎ Draw** to add a drawing below the cursor. Set a folder and tags above.
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
    <div class="side-foot" id="side-foot"></div>
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

const editorOpts: EditorOptions = {
  onChange(doc) {
    if (!current) return;
    current.body = doc;
    scheduleSave();
  },
  extensions: [inkField],
};
const view: EditorView = createEditor($('.editor-host'), '', editorOpts);
$('#tools').appendChild(buildInkToolbar(() => insertInk(view)));

setInkSaveHook((ink) => {
  void db.saveInk(ink).then(() => setStatus('Saved'));
});

function setStatus(s: string) {
  statusEl.textContent = s;
}

function scheduleSave() {
  setStatus('Editing…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!current) return;
  await db.saveNote(current);
  setStatus('Saved');
  renderList();
}

// ------------------------------------------------------------------ notes

export async function openNote(id: string) {
  if (current) await flushSave();
  const note = await db.getNote(id);
  if (!note || note.deleted) return;
  current = note;
  setCurrentNote(note.id);
  for (const ink of await db.inksForNote(note.id)) cacheInk(ink);
  loadDoc(view, note.body, editorOpts);
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
  await db.deleteNote(current.id);
  current = null;
  await refresh();
});

const parseTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];

folderEl.addEventListener('change', () => {
  if (!current) return;
  current.folder = folderEl.value.trim();
  void flushSave().then(renderFilters);
});
tagsEl.addEventListener('change', () => {
  if (!current) return;
  current.tags = parseTags(tagsEl.value);
  tagsEl.value = current.tags.join(', ');
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
  const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('![ink]'));
  return (lines[1] ?? '').replace(/[#*_`>$]/g, '').slice(0, 90);
}

function renderList() {
  if (current) notes = notes.map((n) => (n.id === current!.id ? current! : n));
  const shown = notes.filter(matches).sort((a, b) => b.updated - a.updated);
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

// ------------------------------------------------------------------ startup

/** Reload everything from IndexedDB (also called after a sync). */
export async function refresh() {
  notes = await db.allNotes();
  if (!notes.length) {
    await newNote(WELCOME);
    return;
  }
  renderFilters();
  const want = current?.id ?? (await db.getMeta<string>('lastNote'));
  const target = notes.find((n) => n.id === want) ?? [...notes].sort((a, b) => b.updated - a.updated)[0];
  if (current && current.id === target.id) {
    // Same note still open: pick up remote changes only if we have no unsaved edits.
    const fresh = await db.getNote(target.id);
    if (fresh && fresh.body !== current.body && !saveTimer) {
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

void navigator.storage?.persist?.();
void refresh();
