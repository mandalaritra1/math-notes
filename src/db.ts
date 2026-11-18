// Local-first storage in IndexedDB (via the tiny `idb` wrapper).
//
// Everything is saved here first, so the app works fully offline. Drive sync
// later reads the `dirty` flags to know what to upload. Deleting a note keeps
// a "tombstone" (deleted: true) until sync has removed it from Drive too;
// otherwise the next sync would download it again.

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { Stroke } from './ink';

export interface SyncFields {
  /** Changed locally since the last successful sync. */
  dirty: boolean;
  /** Tombstone: delete on Drive at next sync, then purge locally. */
  deleted?: boolean;
  /** Drive file id once uploaded. */
  driveId?: string;
  /** Drive modifiedTime we last synced against. */
  remoteModified?: string;
  /** Same two fields for the note's ink file. */
  inkDriveId?: string;
  inkRemoteModified?: string;
}

export interface Note extends SyncFields {
  id: string;
  body: string;
  folder: string;
  tags: string[];
  /** Pen strokes, in page coordinates. */
  ink: Stroke[];
  /** Pages the user added (the notebook also grows to fit text and ink). */
  pages: number;
  created: number;
  updated: number;
}

interface Schema extends DBSchema {
  notes: { key: string; value: Note };
  meta: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
function db() {
  dbp ??= openDB<Schema>('math-notes', 2, {
    async upgrade(d, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        d.createObjectStore('notes', { keyPath: 'id' });
        d.createObjectStore('meta');
      }
      if (oldVersion === 1) {
        // v1 had separate ink blocks; ink now lives on the note itself.
        (d as unknown as IDBPDatabase).deleteObjectStore('inks');
        const store = tx.objectStore('notes');
        for (const n of await store.getAll()) {
          n.body = n.body.replace(/^!\[ink\]\(ink\/[\w-]+\.svg\)\s*\n?/gm, '');
          n.ink = [];
          await store.put(n);
        }
      }
    },
  });
  return dbp;
}

// ---- notes
export async function allNotes(includeDeleted = false): Promise<Note[]> {
  const notes = await (await db()).getAll('notes');
  return includeDeleted ? notes : notes.filter((n) => !n.deleted);
}
export async function getNote(id: string) {
  return (await db()).get('notes', id);
}
/**
 * Save a local edit (marks it for upload). Only the user-editable fields are
 * taken from `n`; sync bookkeeping (driveId, remoteModified...) is kept from
 * the stored record, which sync may have updated in the meantime.
 */
export async function saveNote(n: Note) {
  const d = await db();
  const prev = await d.get('notes', n.id);
  const { id, body, folder, tags, ink, pages, created } = n;
  n.updated = Date.now();
  await d.put('notes', { ...prev, id, body, folder, tags, ink, pages, created, updated: n.updated, dirty: true });
}
/**
 * Forget which Drive version this note was based on, so the next sync treats
 * the remote copy as changed and keeps it as a conflict copy instead of
 * overwriting it.
 */
export async function markRemoteUnknown(id: string) {
  const d = await db();
  const n = await d.get('notes', id);
  if (n) await d.put('notes', { ...n, remoteModified: undefined, inkRemoteModified: undefined });
}
/** Write a record as-is (used by sync). */
export async function putNoteRaw(n: Note) {
  await (await db()).put('notes', n);
}
export async function purgeNote(id: string) {
  await (await db()).delete('notes', id);
}
export async function deleteNote(id: string) {
  const d = await db();
  const n = await d.get('notes', id);
  if (!n) return;
  if (!n.driveId) return void (await d.delete('notes', id)); // never synced: just drop it
  await d.put('notes', { ...n, body: '', ink: [], deleted: true, dirty: true, updated: Date.now() });
}

// ---- small key/value settings
export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('meta', key)) as T | undefined;
}
export async function setMeta(key: string, value: unknown) {
  await (await db()).put('meta', value, key);
}

// ---- helpers
export function noteTitle(body: string): string {
  const line = body.split('\n').find((l) => l.trim()) ?? '';
  return line.replace(/^#+\s*/, '').trim().slice(0, 120) || 'Untitled';
}
