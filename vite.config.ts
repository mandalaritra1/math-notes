import { defineConfig } from 'vite';

// GitHub Pages serves the app from https://<user>.github.io/math-notes/,
// so production builds need that path prefix. `npm run dev` stays at "/".
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/math-notes/' : '/',
}));
