// One-finger scrolling done in JavaScript.
//
// The note area has `touch-action: none` at all times. That is what stops the
// S Pen from panning the page and stops Android's stylus handwriting-to-text
// from taking over the pen above editable text: Chrome only starts
// handwriting where `touch-action` allows both pan-x and pan-y. The price is
// that the browser no longer scrolls for fingers either, so we do it here,
// with a little momentum after a flick.

export function enableFingerScroll(el: HTMLElement, ignore: () => boolean) {
  let id: number | null = null;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0; // px per ms, positive = content moves up
  let raf = 0;

  el.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType !== 'touch') return;
      cancelAnimationFrame(raf);
      if (id !== null || ignore()) {
        id = null; // a second finger (pinch) or a palm while the pen is in use
        return;
      }
      id = e.pointerId;
      lastY = e.clientY;
      lastT = e.timeStamp;
      velocity = 0;
    },
    { passive: true },
  );

  el.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerId !== id) return;
      if (ignore()) {
        id = null;
        return;
      }
      const dy = e.clientY - lastY;
      const dt = Math.max(1, e.timeStamp - lastT);
      el.scrollTop -= dy;
      velocity = 0.7 * (-dy / dt) + 0.3 * velocity;
      lastY = e.clientY;
      lastT = e.timeStamp;
    },
    { passive: true },
  );

  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    // A finger that stopped before lifting shouldn't fling.
    if (e.timeStamp - lastT > 80 || Math.abs(velocity) < 0.05) return;
    let prev = performance.now();
    const step = (now: number) => {
      const dt = now - prev;
      prev = now;
      el.scrollTop += velocity * dt;
      velocity *= Math.pow(0.996, dt);
      if (Math.abs(velocity) > 0.02) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  el.addEventListener('pointerup', end, { passive: true });
  el.addEventListener('pointercancel', end, { passive: true });
}
