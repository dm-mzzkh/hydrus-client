import { createSignal, onCleanup, onMount, For, type JSX } from "solid-js";

interface Props {
  count: number;
  /** фиксированная высота строки, px (включая зазор) */
  rowHeight: number;
  overscan?: number;
  class?: string;
  renderRow: (index: number) => JSX.Element;
}

/**
 * Виртуализированный список с фиксированной высотой строки: в DOM живут только
 * видимые строки (+overscan). Аналог VirtualGrid, но одна колонка переменной ширины —
 * подходит для строк импорта (чекбокс + миниатюра + имя + бейджи). Зависимостей нет.
 * Контейнер НЕ flex (иначе высокий спейсер схлопнулся бы) — высоту даёт класс из props.
 */
export function VirtualList(props: Props) {
  let container!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  const overscan = () => props.overscan ?? 4;

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(container.clientHeight));
    ro.observe(container);
    setHeight(container.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  const total = () => props.count * props.rowHeight;
  const first = () => Math.max(0, Math.floor(scrollTop() / props.rowHeight) - overscan());
  const last = () => Math.min(props.count, Math.ceil((scrollTop() + height()) / props.rowHeight) + overscan());
  const visible = (): number[] => {
    const out: number[] = [];
    for (let i = first(); i < last(); i++) out.push(i);
    return out;
  };

  return (
    <div ref={container} class={props.class} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: `${total()}px`, position: "relative" }}>
        <For each={visible()}>
          {(idx) => (
            <div style={{ position: "absolute", top: `${idx * props.rowHeight}px`, left: 0, right: 0, height: `${props.rowHeight}px` }}>
              {props.renderRow(idx)}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
