import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves the app from https://<user>.github.io/math-notes/,
// so production builds (and `npm run preview`) use that path prefix.
// `npm run dev` stays at "/".
// (If you rename the GitHub repo, change this to match.)
const PAGES_BASE = '/math-notes/';

export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? PAGES_BASE : '/',
  build: { chunkSizeWarningLimit: 1200 }, // CodeMirror + KaTeX in one bundle is fine for an offline app
  plugins: [
    // Generates the web app manifest and a service worker that precaches the
    // whole app (JS, CSS, KaTeX fonts, icons) so it starts with no network.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Math Notes',
        short_name: 'Math Notes',
        description: 'Markdown + LaTeX notes with pen ink, synced to Google Drive',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        background_color: '#16181d',
        theme_color: '#1f2937',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // woff2 only: every browser that can run the app uses it, so the
        // older KaTeX .woff/.ttf copies don't need to be stored offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
}));
