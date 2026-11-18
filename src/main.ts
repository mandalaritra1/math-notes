import './style.css';
import { createEditor } from './editor';

const SAMPLE = `# Welcome

Inline math like $E = mc^2$ or $\\int_0^\\infty e^{-x^2}\\,dx = \\tfrac{\\sqrt\\pi}{2}$ renders as you type.
Click a formula to edit its source.

$$
\\mathcal{L} = -\\frac14 F_{\\mu\\nu}F^{\\mu\\nu} + \\bar\\psi(i\\gamma^\\mu D_\\mu - m)\\psi
$$

**Bold**, *italic*, \`code\`, and lists:

- item one
- item two
`;

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="main">
    <div class="topbar"><strong>Math Notes</strong><span class="spacer"></span></div>
    <div class="editor-scroll"><div class="editor-host"></div></div>
  </div>`;

createEditor(app.querySelector('.editor-host')!, SAMPLE, { onChange: () => {} });
