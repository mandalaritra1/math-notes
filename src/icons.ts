// Small stroke icons (24x24, currentColor), drawn by hand for this app.
const svg = (body: string) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  search: svg('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
  trash: svg('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>'),
  sync: svg('<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3v4h-4M6.5 21v-4h4"/>'),
  pen: svg('<path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1.5L5.5 15.5z"/><path d="m13.5 6.5 3 3"/>'),
  eraser: svg('<path d="M8.5 19.5 3.8 14.8a1.8 1.8 0 0 1 0-2.6l8.4-8.4a1.8 1.8 0 0 1 2.6 0l4.4 4.4a1.8 1.8 0 0 1 0 2.6l-8.6 8.7z"/><path d="M8.5 19.5H20M8 9.5l6 6"/>'),
  mouse: svg('<path d="M5 3.5 18.5 10l-6 1.8-2.3 6.2z"/>'),
  undo: svg('<path d="M9 14 4.5 9.5 9 5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 0 11h-3"/>'),
  redo: svg('<path d="m15 14 4.5-4.5L15 5"/><path d="M19.5 9.5H10a5.5 5.5 0 0 0 0 11h3"/>'),
  folder: svg('<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.5l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v7.8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  tag: svg('<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.5 1.5 0 0 1 0 2.1l-6.2 6.2a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.3"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
};
