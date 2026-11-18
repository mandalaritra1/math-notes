// CodeMirror 6 editor: Markdown highlighting + live math.
import { EditorState, Extension } from '@codemirror/state';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { mathField } from './math';

const mdStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.6em', fontWeight: '700' },
  { tag: t.heading2, fontSize: '1.35em', fontWeight: '700' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--code)' },
  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
]);

export interface EditorOptions {
  onChange: (doc: string) => void;
  /** Extra extensions (ink blocks are plugged in here). */
  extensions?: Extension[];
}

export function makeState(doc: string, opts: EditorOptions): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdStyle),
      mathField,
      ...(opts.extensions ?? []),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange(u.state.doc.toString());
      }),
    ],
  });
}

export function createEditor(parent: HTMLElement, doc: string, opts: EditorOptions): EditorView {
  return new EditorView({ parent, state: makeState(doc, opts) });
}

/** Swap in another note (fresh undo history). */
export function loadDoc(view: EditorView, doc: string, opts: EditorOptions) {
  view.setState(makeState(doc, opts));
}
