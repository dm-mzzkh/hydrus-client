import { onCleanup, onMount } from "solid-js";

/**
 * Закрытие оверлея по Escape: вешает window-listener на время жизни компонента.
 * stopPropagation, чтобы под модалкой ничего больше не среагировало на Escape.
 */
export function onEscape(cb: () => void): void {
  onMount(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cb();
      }
    };
    window.addEventListener("keydown", h);
    onCleanup(() => window.removeEventListener("keydown", h));
  });
}
