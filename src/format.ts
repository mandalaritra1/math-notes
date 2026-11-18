// How notes and ink look as files on Google Drive.
//
//   Math Notes/
//     Quantum notes.md        <- YAML frontmatter + the Markdown body
//     ink/
//       <note id>.json        <- the pen strokes drawn over that note
//
// Strokes are anchored to character positions in the note body, so the .md
// and its ink file are always uploaded and downloaded together.

import type { Note } from './db';
import type { Stroke } from './ink';

// ------------------------------------------------------------------ notes

export function noteToMarkdown(n: Note): string {
  const fm = [
    '---',
    `id: ${n.id}`,
    `folder: ${JSON.stringify(n.folder)}`,
    `tags: [${n.tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    `created: ${new Date(n.created).toISOString()}`,
    `updated: ${new Date(n.updated).toISOString()}`,
    '---',
    '',
  ];
  return fm.join('\n') + n.body;
}

/** Parse our own frontmatter (a small YAML subset). */
export function markdownToNote(text: string, fallbackId: string): Omit<Note, 'dirty' | 'ink'> {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const fields: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (kv) fields[kv[1]] = kv[2].trim();
    }
  }
  const body = m ? text.slice(m[0].length) : text; // exact: ink anchors are offsets into the body
  const str = (v?: string) => {
    if (!v) return '';
    try {
      return String(JSON.parse(v));
    } catch {
      return v.replace(/^['"]|['"]$/g, '');
    }
  };
  let tags: string[] = [];
  if (fields.tags) {
    try {
      tags = JSON.parse(fields.tags);
    } catch {
      tags = fields.tags.replace(/^\[|\]$/g, '').split(',').map(str).filter(Boolean);
    }
  }
  const time = (v?: string) => (v && !isNaN(Date.parse(v)) ? Date.parse(v) : Date.now());
  return {
    id: fields.id || fallbackId,
    body,
    folder: str(fields.folder),
    tags: tags.map(String),
    created: time(fields.created),
    updated: time(fields.updated),
  };
}

export function fileNameFor(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|#\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return (safe || 'Untitled') + '.md';
}

// ------------------------------------------------------------------ ink

export function inkToJson(n: Note): string {
  return JSON.stringify({ v: 1, noteId: n.id, strokes: n.ink });
}

export function jsonToInk(text: string): Stroke[] {
  try {
    const d = JSON.parse(text);
    return Array.isArray(d.strokes) ? d.strokes : [];
  } catch {
    return [];
  }
}
