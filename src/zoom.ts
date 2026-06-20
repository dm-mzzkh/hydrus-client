import { createSignal, onCleanup, onMount } from "solid-js";

/**
 * Зум/пан медиа-области (колесо, перетаскивание, +/−, fit↔1:1) — общий код для
 * полноэкранного просмотра. Используется и галерейным FileViewer, и лайтбоксом
 * импортёра, чтобы логику не дублировать. Возвращает сигналы + обработчики + ref-колбэки
 * на внешний контейнер (`mediaRef`) и трансформируемую обёртку (`innerRef`).
 */
export function createZoomPan() {
  const [scale, setScale] = createSignal(1);
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [actual, setActual] = createSignal(false); // false = fit, true = 1:1
  let mediaEl: HTMLElement | undefined;
  let innerEl: HTMLElement | undefined;
  let dragging = false;
  let moved = false;
  let lastDragEndAt = 0;
  let sx = 0, sy = 0, ox = 0, oy = 0;

  const reset = () => { setScale(1); setTx(0); setTy(0); };

  // клампинг пана: не уводим масштабированный контент дальше края вьюпорта.
  // offsetWidth дочернего <img>/<video> не зависит от CSS-трансформа → стабилен.
  function clamp() {
    if (!mediaEl) return;
    const child = innerEl?.firstElementChild as HTMLElement | null;
    const cw = mediaEl.clientWidth;
    const ch = mediaEl.clientHeight;
    const s = scale();
    const iw = (child?.offsetWidth ?? cw) * s;
    const ih = (child?.offsetHeight ?? ch) * s;
    const bx = Math.max(0, (iw - cw) / 2);
    const by = Math.max(0, (ih - ch) / 2);
    setTx((x) => Math.max(-bx, Math.min(bx, x)));
    setTy((y) => Math.max(-by, Math.min(by, y)));
  }

  function zoomAt(factor: number, cx = 0, cy = 0) {
    const s = scale();
    const s2 = Math.min(10, Math.max(0.15, s * factor));
    if (s2 === s) return;
    const r = s2 / s;
    setTx(cx - r * (cx - tx()));
    setTy(cy - r * (cy - ty()));
    setScale(s2);
    clamp();
  }

  function onMove(e: MouseEvent) {
    if (!dragging) return;
    moved = true;
    setTx(ox + (e.clientX - sx));
    setTy(oy + (e.clientY - sy));
    clamp();
  }
  function onUp() {
    if (moved) lastDragEndAt = performance.now();
    dragging = false;
  }
  // preventDefault=false для интерактивных типов (видео/Flash) — мышь отдаём им
  function onDown(e: MouseEvent, preventDefault = true) {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    sx = e.clientX; sy = e.clientY; ox = tx(); oy = ty();
    if (preventDefault) e.preventDefault();
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // нормализуем дельту к пикселям, затем экспоненциальный шаг — плавно на тачпаде
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; // строки
    else if (e.deltaMode === 2) dy *= rect.height; // страницы
    const factor = Math.exp(-dy * 0.0018);
    zoomAt(factor, e.clientX - (rect.left + rect.width / 2), e.clientY - (rect.top + rect.height / 2));
  }
  // был ли только что drag (чтобы клик после пана не считался «закрыть»)
  const justDragged = () => performance.now() - lastDragEndAt < 250;

  onMount(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  });

  const mediaRef = (el: HTMLElement) => { mediaEl = el; };
  const innerRef = (el: HTMLElement) => { innerEl = el; };
  const getMedia = () => mediaEl;
  const transform = () => `translate(${tx()}px, ${ty()}px) scale(${scale()})`;

  return { scale, tx, ty, actual, setActual, reset, clamp, zoomAt, onDown, onWheel, justDragged, mediaRef, innerRef, getMedia, transform };
}
