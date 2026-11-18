// CodeMirror 6 editor: Markdown highlighting + live math.
import { EditorState, Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { findMath, mathField } from './math';

// Colours and heading font come from the notebook's text theme (theme.ts).
const mdStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.6em', fontWeight: '700', color: 'var(--md-h1)', fontFamily: 'var(--md-heading-font)' },
  { tag: t.heading2, fontSize: '1.35em', fontWeight: '700', color: 'var(--md-h2)', fontFamily: 'var(--md-heading-font)' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '700', color: 'var(--md-h3)', fontFamily: 'var(--md-heading-font)' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--md-h3)', fontFamily: 'var(--md-heading-font)' },
  { tag: t.strong, fontWeight: '700', color: 'var(--md-strong)' },
  { tag: t.emphasis, fontStyle: 'italic', color: 'var(--md-em)' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.monospace, fontFamily: 'var(--mono)', color: 'var(--md-code)' },
  { tag: [t.link, t.url], color: 'var(--md-link)' },
  { tag: [t.processingInstruction, t.meta], color: 'var(--md-mark)' },
  { tag: t.quote, color: 'var(--md-quote)', fontStyle: 'italic' },
]);

// CodeMirror's built-in theme paints the caret black with a more specific
// selector than plain CSS, which made it invisible in dark mode. A theme
// extension wins over the base theme.
const appTheme = EditorView.theme({
  '.cm-content': { caretColor: 'var(--text)', color: 'var(--text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--page-sel)',
  },
});

// ------------------------------------------------------------ live preview of Markdown marks
//
// Hide the syntax characters (# of headings, ** and _ of emphasis, backticks
// of inline code, ~~) on every line except the ones the cursor is on, so the
// note reads like formatted text but stays plain Markdown underneath.
// Bullets ("-", "*", "+") are shown as a real bullet.

const HIDDEN = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'StrikethroughMark']);

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });
const hide = Decoration.replace({});

function buildMarks(view: EditorView): DecorationSet {
  const { state } = view;
  const active = new Set<number>();
  // Only the focused editor reveals marks (so an unfocused or printed note reads clean).
  if (view.hasFocus) for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) active.add(n);
  }
  const math = findMath(state.doc.toString());
  const inMath = (pos: number) => math.some((m) => pos >= m.from && pos < m.to);
  const b = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        const isList = n.name === 'ListMark';
        if (!HIDDEN.has(n.name) && !isList) return;
        if (active.has(state.doc.lineAt(n.from).number) || inMath(n.from)) return;
        if (n.name === 'CodeMark' && n.node.parent?.name === 'FencedCode') return; // keep ``` fences
        if (isList) {
          if (/^[-*+]$/.test(state.doc.sliceString(n.from, n.to)) && n.node.parent?.parent?.name === 'BulletList') b.add(n.from, n.to, bullet);
          return;
        }
        let end = n.to;
        if (n.name === 'HeaderMark' && state.doc.sliceString(end, end + 1) === ' ') end++;
        if (end > n.from) b.add(n.from, end, hide);
      },
    });
  }
  return b.finish();
}

const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildMarks(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = buildMarks(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export interface EditorOptions {
  /** Called when the text or the ink changed. */
  onChange: (state: EditorState) => void;
}

/** `perDoc`: extensions seeded with this note's data (its ink strokes). */
export function makeState(doc: string, opts: EditorOptions, perDoc: Extension[] = []): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      appTheme,
      EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdStyle),
      mathField,
      livePreview,
      ...perDoc,
      EditorView.updateListener.of((u) => {
        if (u.docChanged || u.transactions.some((t) => t.effects.length)) opts.onChange(u.state);
      }),
    ],
  });
}

export function createEditor(parent: HTMLElement, doc: string, opts: EditorOptions, perDoc: Extension[] = []): EditorView {
  return new EditorView({ parent, state: makeState(doc, opts, perDoc) });
}

/** Swap in another note (fresh undo history). */
export function loadDoc(view: EditorView, doc: string, opts: EditorOptions, perDoc: Extension[] = []) {
  view.setState(makeState(doc, opts, perDoc));
}
