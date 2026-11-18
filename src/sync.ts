// Google Drive sync -- runs entirely in the browser, no server.
//
// Sign-in uses Google Identity Services (GIS): a pop-up asks you to allow the
// app, and Google hands back a short-lived (1 h) access token. The token only
// grants the `drive.file` scope: the app can see and edit files *it created*,
// nothing else in your Drive.
//
// Sync is "local first": IndexedDB is the source of truth on each device.
// Each sync:
//   1. lists the files in the "Math Notes" folder (and its "ink" subfolder)
//   2. uploads local changes (dirty notes), trashes remote copies of notes
//      deleted here, downloads notes changed elsewhere. A note and its ink
//      file always travel together.
//   3. if a note changed on BOTH sides, the local version wins and the
//      remote version is kept as a separate "(conflict copy)" note.

import * as db from './db';
import type { Note } from './db';
import { fileNameFor, inkToJson, jsonToInk, markdownToNote, noteToMarkdown } from './format';
import { newId } from './ink';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const ROOT_NAME = 'Math Notes';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// ------------------------------------------------------------------ auth

/* Minimal typing for the bits of GIS we use. */
interface TokenResponse {
  access_token: string;
  expires_in: number;
  error?: string;
}
interface TokenClient {
  requestAccessToken(o?: { prompt?: string }): void;
}
declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(c: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }): TokenClient;
          revoke(token: string, done?: () => void): void;
        };
      };
    };
  }
}

let gisPromise: Promise<void> | null = null;
/** Load the Google sign-in script on demand (so the app still starts offline). */
export function loadGis(): Promise<void> {
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Could not load Google sign-in (offline?)'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

const TOKEN_KEY = 'mn-drive-token';
function storedToken(): string | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null');
    return t && t.expires > Date.now() + 60_000 ? t.value : null;
  } catch {
    return null;
  }
}
export const currentToken = storedToken;

let tokenClient: TokenClient | null = null;
let tokenClientId = '';
let pending: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null;

/**
 * Get an access token. Call this directly from a click handler: browsers only
 * allow the Google pop-up in response to a user gesture.
 */
export function getToken(clientId: string): Promise<string> {
  const t = storedToken();
  if (t) return Promise.resolve(t);
  if (!window.google) return loadGis().then(() => getToken(clientId));
  if (!tokenClient || tokenClientId !== clientId) {
    tokenClientId = clientId;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) pending?.reject(new Error(r.error || 'No token'));
        else {
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ value: r.access_token, expires: Date.now() + r.expires_in * 1000 }));
          pending?.resolve(r.access_token);
        }
        pending = null;
      },
      error_callback: (e) => {
        pending?.reject(new Error(e.message || e.type));
        pending = null;
      },
    });
  }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient!.requestAccessToken({ prompt: '' });
  });
}

export function signOut() {
  const t = storedToken();
  sessionStorage.removeItem(TOKEN_KEY);
  if (t) window.google?.accounts.oauth2.revoke(t);
}

// ------------------------------------------------------------------ Drive REST helpers

interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  appProperties?: Record<string, string>;
}

class AuthError extends Error {}

async function call(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new AuthError('Google sign-in expired, press Sync again');
  }
  if (!res.ok) throw new Error(`Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res;
}

async function listFolder(token: string, folderId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const fields = encodeURIComponent('nextPageToken,files(id,name,modifiedTime,appProperties)');
    const r = await call(token, `${API}/files?q=${q}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`);
    const j = await r.json();
    out.push(...j.files);
    pageToken = j.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

/** Find or create a folder. `created` = it did not exist (or was trashed). */
async function ensureFolder(token: string, name: string, parent: string, metaKey: string): Promise<{ id: string; created: boolean }> {
  const cached = await db.getMeta<string>(metaKey);
  if (cached) {
    try {
      const r = await call(token, `${API}/files/${cached}?fields=id,trashed`);
      if (!(await r.json()).trashed) return { id: cached, created: false };
    } catch (e) {
      if (e instanceof AuthError) throw e; // otherwise: folder gone, recreate below
    }
  }
  const q = encodeURIComponent(`mimeType='${FOLDER_MIME}' and name='${name}' and '${parent}' in parents and trashed=false`);
  const found = (await (await call(token, `${API}/files?q=${q}&fields=files(id)`)).json()).files as { id: string }[];
  let id = found[0]?.id;
  const created = !id;
  if (!id) {
    const r = await call(token, `${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    });
    id = (await r.json()).id as string;
  }
  await db.setMeta(metaKey, id);
  return { id, created };
}

/** Create (no fileId) or update a file with metadata + content in one request. */
async function upload(
  token: string,
  meta: Record<string, unknown>,
  content: string,
  mime: string,
  fileId?: string,
): Promise<{ id: string; modifiedTime: string }> {
  const b = 'mn' + newId();
  const body =
    `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${b}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
  const url = fileId
    ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,modifiedTime`
    : `${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`;
  const r = await call(token, url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${b}` },
    body,
  });
  return r.json();
}

async function download(token: string, id: string): Promise<string> {
  return (await call(token, `${API}/files/${id}?alt=media`)).text();
}

async function trash(token: string, id: string) {
  try {
    await call(token, `${API}/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  } catch (e) {
    if (e instanceof AuthError) throw e; // 404 = already gone, fine
  }
}

// ------------------------------------------------------------------ sync

export interface SyncResult {
  up: number;
  down: number;
  deleted: number;
  conflicts: number;
  /** Ids of notes whose content was replaced by the Drive version. */
  pulled: string[];
}

let running: Promise<SyncResult> | null = null;

/** Run one sync (concurrent calls share the run in progress). */
export function sync(token: string): Promise<SyncResult> {
  running ??= doSync(token).finally(() => (running = null));
  return running;
}

async function doSync(token: string): Promise<SyncResult> {
  const res: SyncResult = { up: 0, down: 0, deleted: 0, conflicts: 0, pulled: [] };
  const rootDir = await ensureFolder(token, ROOT_NAME, 'root', 'driveRoot');
  const root = rootDir.id;
  if (rootDir.created) {
    // A brand-new remote (first sync, folder deleted in Drive, or another
    // Google account): nothing local was "deleted elsewhere", so upload it all
    // instead of treating missing files as remote deletions.
    for (const n of await db.allNotes(true)) {
      if (n.deleted) await db.purgeNote(n.id);
      else
        await db.putNoteRaw({ ...n, dirty: true, driveId: undefined, remoteModified: undefined, inkDriveId: undefined, inkRemoteModified: undefined });
    }
  }
  const inkDir = (await ensureFolder(token, 'ink', root, 'driveInk')).id;
  const remoteNotes = byId(await listFolder(token, root), 'note');
  const remoteInks = byId(await listFolder(token, inkDir), 'ink');

  for (const local of await db.allNotes(true)) {
    const r = remoteNotes.get(local.id);
    const ri = remoteInks.get(local.id);
    remoteNotes.delete(local.id);
    remoteInks.delete(local.id);
    if (local.deleted) {
      if (r) await trash(token, r.id);
      if (ri) await trash(token, ri.id);
      await db.purgeNote(local.id);
      res.deleted++;
    } else if (!r) {
      if (local.driveId && !local.dirty) {
        await db.purgeNote(local.id); // deleted on another device
        res.deleted++;
      } else {
        await pushNote(token, local, root, inkDir, undefined, ri?.id);
        res.up++;
      }
    } else {
      const remoteChanged = r.modifiedTime !== local.remoteModified || ri?.modifiedTime !== local.inkRemoteModified;
      if (local.dirty && remoteChanged) {
        await pushNote(token, await saveConflictCopy(token, r, ri), root, inkDir);
        await pushNote(token, local, root, inkDir, r.id, ri?.id);
        res.conflicts++;
      } else if (local.dirty) {
        await pushNote(token, local, root, inkDir, r.id, ri?.id);
        res.up++;
      } else if (remoteChanged) {
        if (await pullNote(token, r, ri)) res.pulled.push(local.id);
        res.down++;
      }
    }
  }
  for (const r of remoteNotes.values()) {
    if (await pullNote(token, r, remoteInks.get(r.appProperties!.mnId))) res.pulled.push(r.appProperties!.mnId);
    res.down++;
  }

  await db.setMeta('lastSync', Date.now());
  return res;
}

function byId(files: DriveFile[], kind: string): Map<string, DriveFile> {
  const m = new Map<string, DriveFile>();
  for (const f of files) {
    const id = f.appProperties?.mnId;
    if (id && f.appProperties?.mnKind === kind) m.set(id, f);
  }
  return m;
}

async function pushNote(token: string, n: Note, root: string, inkDir: string, fileId?: string, inkFileId?: string) {
  const meta: Record<string, unknown> = { name: fileNameFor(db.noteTitle(n.body)), mimeType: 'text/markdown' };
  if (!fileId) Object.assign(meta, { parents: [root], appProperties: { mnId: n.id, mnKind: 'note' } });
  const out = await upload(token, meta, noteToMarkdown(n), 'text/markdown', fileId);

  let inkOut: { id: string; modifiedTime: string } | undefined;
  if (n.ink.length || inkFileId) {
    const inkMeta: Record<string, unknown> = { name: `${n.id}.json`, mimeType: 'application/json' };
    if (!inkFileId) Object.assign(inkMeta, { parents: [inkDir], appProperties: { mnId: n.id, mnKind: 'ink' } });
    inkOut = await upload(token, inkMeta, inkToJson(n), 'application/json', inkFileId);
  }
  // Only clear `dirty` if nobody edited the note while we were uploading.
  const now = await db.getNote(n.id);
  if (!now) return;
  await db.putNoteRaw({
    ...now,
    driveId: out.id,
    remoteModified: out.modifiedTime,
    inkDriveId: inkOut?.id,
    inkRemoteModified: inkOut?.modifiedTime,
    dirty: now.updated !== n.updated,
  });
}

async function fetchNote(token: string, r: DriveFile, ri: DriveFile | undefined, id: string) {
  const parsed = markdownToNote(await download(token, r.id), id);
  const ink = ri ? jsonToInk(await download(token, ri.id)) : [];
  return { ...parsed, id, ink };
}

/** Returns false if skipped because the note was edited locally meanwhile. */
async function pullNote(token: string, r: DriveFile, ri: DriveFile | undefined): Promise<boolean> {
  const id = r.appProperties!.mnId;
  const note = await fetchNote(token, r, ri, id);
  const now = await db.getNote(id);
  if (now?.dirty) return false; // edited meanwhile; the next sync resolves it
  await db.putNoteRaw({
    ...note,
    driveId: r.id,
    remoteModified: r.modifiedTime,
    inkDriveId: ri?.id,
    inkRemoteModified: ri?.modifiedTime,
    dirty: false,
  });
  return true;
}

async function saveConflictCopy(token: string, r: DriveFile, ri: DriveFile | undefined): Promise<Note> {
  const id = newId();
  const note = await fetchNote(token, r, ri, id);
  const lines = note.body.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i >= 0) lines[i] += ' (conflict copy)';
  const copy: Note = { ...note, body: lines.join('\n'), updated: Date.now(), dirty: true };
  await db.putNoteRaw(copy);
  return copy;
}
