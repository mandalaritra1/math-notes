import './style.css';
import { createEditor } from './editor';
import { buildInkToolbar, inkField, insertInk } from './ink';

const SAMPLE = `# Welcome

Inline math like $E = mc^2$ or $\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt\\pi}{2}$ renders as you type.
Click a formula to edit its source.

$$
\\mathcal{L} = -\\frac14 F_{\\mu\\nu}F^{\\mu\\nu} + \\bar\\psi(i\\gamma^\\mu D_\\mu - m)\\psi
$$

**Bold**, *italic*, \`code\`, and lists:

- item one
- item two

Press **✎ Draw** to add a drawing below the cursor.
`;

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="main">
    <div class="topbar"><strong>Math Notes</strong><span class="spacer"></span></div>
    <div class="editor-scroll"><div class="editor-host"></div></div>
  </div>`;

const view = createEditor(app.querySelector('.editor-host')!, SAMPLE, {
  onChange: () => {},
  extensions: [inkField],
});
app.querySelector('.topbar')!.appendChild(buildInkToolbar(() => insertInk(view)));
