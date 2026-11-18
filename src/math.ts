// Live LaTeX rendering inside CodeMirror.
//
// We scan the document for $...$ (inline) and $$...$$ (display) math and
// replace each one with a KaTeX-rendered widget -- except the one your cursor
// is in, which is shown as source so you can edit it (Obsidian-style).
// Display math being edited also gets a live preview underneath.
//
// The decorations come from a StateField (not a ViewPlugin) because
// CodeMirror only allows block widgets and replacements that span line
// breaks when they are provided directly by state.

import { EditorState, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export interface MathSpan {
  from: number;
  to: number;
  tex: string;
  display: boolean;
}

/** Find math spans, skipping fenced code blocks, inline code and escaped \$. */
export function findMath(text: string): MathSpan[] {
  const out: MathSpan[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const atLineStart = i === 0 || text[i - 1] === '\n';
    if (atLineStart && (text.startsWith('```', i) || text.startsWith('~~~', i))) {
      const fence = text.slice(i, i + 3);
      const close = text.indexOf('\n' + fence, i + 3);
      if (close < 0) break; // unterminated fence: rest of doc is code
      const eol = text.indexOf('\n', close + 1 + 3);
      i = eol < 0 ? n : eol;
      continue;
    }
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (text[k] === '`') k++;
      const close = text.indexOf(text.slice(i, k), k);
      i = close < 0 ? k : close + (k - i);
      continue;
    }
    if (c === '$') {
      if (text[i + 1] === '$') {
        const close = text.indexOf('$$', i + 2);
        if (close < 0) {
          i += 2;
          continue;
        }
        out.push({ from: i, to: close + 2, tex: text.slice(i + 2, close), display: true });
        i = close + 2;
        continue;
      }
      // Inline: opening $ must not be followed by whitespace, closing $ must
      // not be preceded by whitespace or followed by a digit ("costs $5 and $6").
      if (i + 1 < n && !/\s/.test(text[i + 1])) {
        let j = i + 1;
        while (j < n && text[j] !== '\n' && text[j] !== '$') j += text[j] === '\\' ? 2 : 1;
        if (j < n && text[j] === '$' && !/\s/.test(text[j - 1]) && !/\d/.test(text[j + 1] ?? '')) {
          out.push({ from: i, to: j + 1, tex: text.slice(i + 1, j), display: false });
          i = j + 1;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}

const htmlCache = new Map<string, string>();
function renderTex(tex: string, display: boolean): string {
  const key = (display ? 'D' : 'I') + tex;
  let html = htmlCache.get(key);
  if (html === undefined) {
    html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
    if (htmlCache.size > 2000) htmlCache.clear();
    htmlCache.set(key, html);
  }
  return html;
}

class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly preview = false,
  ) {
    super();
  }
  eq(o: MathWidget) {
    return o.tex === this.tex && o.display === this.display && o.preview === this.preview;
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-math-display' : 'cm-math-inline';
    if (this.preview) el.classList.add('cm-math-preview');
    el.innerHTML = renderTex(this.tex, this.display);
    if (!this.preview) {
      // Click a rendered formula to edit its source.
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pos = view.posAtDOM(el);
        view.dispatch({ selection: { anchor: pos + (this.display ? 2 : 1) } });
        view.focus();
      });
    }
    return el;
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const text = doc.toString();
  const decos: Range<Decoration>[] = [];
  for (const m of findMath(text)) {
    if (!m.tex.trim()) continue;
    const editing = state.selection.ranges.some((r) => r.from <= m.to && r.to >= m.from);
    if (m.display) {
      const first = doc.lineAt(m.from);
      const last = doc.lineAt(m.to);
      const ownLines =
        text.slice(first.from, m.from).trim() === '' && text.slice(m.to, last.to).trim() === '';
      if (editing) {
        if (ownLines)
          decos.push(
            Decoration.widget({ widget: new MathWidget(m.tex, true, true), block: true, side: 1 }).range(last.to),
          );
      } else if (ownLines) {
        decos.push(Decoration.replace({ widget: new MathWidget(m.tex, true), block: true }).range(first.from, last.to));
      } else {
        decos.push(Decoration.replace({ widget: new MathWidget(m.tex, true) }).range(m.from, m.to));
      }
    } else if (!editing) {
      decos.push(Decoration.replace({ widget: new MathWidget(m.tex, false) }).range(m.from, m.to));
    }
  }
  return Decoration.set(decos, true);
}

export const mathField = StateField.define<DecorationSet>({
  create: buildDecorations,
  update(deco, tr) {
    return tr.docChanged || tr.selection ? buildDecorations(tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
