import { createSignal, onCleanup, onMount, For, type JSX } from "solid-js";

interface Props {
  count: number;
  /** сторона квадратной ячейки, px */
  cellSize: number;
  /** зазор между ячейками, px */
  gap: number;
  renderCell: (index: number) => JSX.Element;
}

/**
 * Виртуализированная сетка фиксированного размера: в DOM живут только видимые
 * ячейки (+overscan), поэтому 30 000 миниатюр скроллятся без тормозов.
 * Зависимостей нет — обычная математика по scrollTop и ширине контейнера.
 */
export function VirtualGrid(props: Props) {
  let container!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [size, setSize] = createSignal({ w: 0, h: 0 });
  const OVERSCAN = 3;

  onMount(() => {
    const ro = new ResizeObserver(() =>
      setSize({ w: container.clientWidth, h: container.clientHeight }),
    );
    ro.observe(container);
    onCleanup(() => ro.disconnect());
  });

  const step = () => props.cellSize + props.gap;
  const cols = () => Math.max(1, Math.floor((size().w + props.gap) / step()));
  const rowCount = () => Math.ceil(props.count / cols());
  const totalHeight = () => rowCount() * step();

  const visible = (): number[] => {
    const c = cols();
    const first = Math.max(0, Math.floor(scrollTop() / step()) - OVERSCAN);
    const last = Math.min(rowCount(), Math.ceil((scrollTop() + size().h) / step()) + OVERSCAN);
    const items: number[] = [];
    for (let row = first; row < last; row++) {
      for (let col = 0; col < c; col++) {
        const idx = row * c + col;
        if (idx < props.count) items.push(idx);
      }
    }
    return items;
  };

  return (
    <div
      ref={container}
      class="vgrid"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: `${totalHeight()}px`, position: "relative" }}>
        <For each={visible()}>
          {(idx) => {
            const c = cols();
            const x = (idx % c) * step();
            const y = Math.floor(idx / c) * step();
            return (
              <div
                class="vcell"
                style={{
                  transform: `translate(${x}px, ${y}px)`,
                  width: `${props.cellSize}px`,
                  height: `${props.cellSize}px`,
                }}
              >
                {props.renderCell(idx)}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
