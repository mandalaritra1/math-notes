// Local-first storage in IndexedDB (via the tiny `idb` wrapper).
//
// Everything is saved here first, so the app works fully offline. Drive sync
// later reads the `dirty` flags to know what to upload. Deleting a note keeps
// a "tombstone" (deleted: true) until sync has removed it from Drive too;
// otherwise the next sync would download it again.

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import type { InkData } from './ink';

export interface SyncFields {
  /** Changed locally since the last successful sync. */
  dirty: boolean;
  /** Tombstone: delete on Drive at next sync, then purge locally. */
  deleted?: boolean;
  /** Drive file id once uploaded. */
  driveId?: string;
  /** Drive modifiedTime we last synced against. */
  remoteModified?: string;
}

export interface Note extends SyncFields {
  id: string;
  body: string;
  folder: string;
  tags: string[];
  created: number;
  updated: number;
}

export type InkRecord = InkData & SyncFields;

interface Schema extends DBSchema {
  notes: { key: string; value: Note };
  inks: { key: string; value: InkRecord; indexes: { noteId: string } };
  meta: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
function db() {
  dbp ??= openDB<Schema>('math-notes', 1, {
    upgrade(d) {
      d.createObjectStore('notes', { keyPath: 'id' });
      d.createObjectStore('inks', { keyPath: 'id' }).createIndex('noteId', 'noteId');
      d.createObjectStore('meta');
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
/** Save a local edit (marks it for upload). */
export async function saveNote(n: Note) {
  n.updated = Date.now();
  n.dirty = true;
  await (await db()).put('notes', n);
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
  for (const ink of await d.getAllFromIndex('inks', 'noteId', id)) await deleteInk(ink);
  if (!n.driveId) return void (await d.delete('notes', id)); // never synced: just drop it
  await d.put('notes', { ...n, body: '', deleted: true, dirty: true, updated: Date.now() });
}

// ---- inks
export async function inksForNote(noteId: string): Promise<InkRecord[]> {
  return (await (await db()).getAllFromIndex('inks', 'noteId', noteId)).filter((i) => !i.deleted);
}
export async function allInks(includeDeleted = false): Promise<InkRecord[]> {
  const inks = await (await db()).getAll('inks');
  return includeDeleted ? inks : inks.filter((i) => !i.deleted);
}
export async function getInkRecord(id: string) {
  return (await db()).get('inks', id);
}
export async function saveInk(ink: InkData) {
  const d = await db();
  const prev = await d.get('inks', ink.id);
  await d.put('inks', { ...prev, ...structuredClone(ink), dirty: true, deleted: false });
}
export async function putInkRaw(ink: InkRecord) {
  await (await db()).put('inks', ink);
}
export async function purgeInk(id: string) {
  await (await db()).delete('inks', id);
}
export async function deleteInk(ink: InkRecord) {
  const d = await db();
  if (!ink.driveId) return void (await d.delete('inks', ink.id));
  await d.put('inks', { ...ink, strokes: [], deleted: true, dirty: true });
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
  const line = body.split('\n').find((l) => l.trim() && !l.startsWith('![ink]')) ?? '';
  return line.replace(/^#+\s*/, '').trim().slice(0, 120) || 'Untitled';
}
