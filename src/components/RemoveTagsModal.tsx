import { createResource, createSignal, For, Show } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { TagLabel } from "./TagLabel";
import { onEscape } from "../util";

/**
 * Окно удаления тега из выделения. Агрегирует display-теги всех выбранных файлов и
 * показывает, у скольких файлов есть каждый тег (по убыванию). Клик по строке удаляет
 * тег из всего набора (через onRemove) и убирает строку из списка.
 */
export function RemoveTagsModal(props: {
  api: HydrusApi;
  ids: number[];
  onRemove: (tag: string) => void;
  onClose: () => void;
}) {
  const [removed, setRemoved] = createSignal<Set<string>>(new Set());
  const [filter, setFilter] = createSignal("");
  onEscape(() => props.onClose());

  // [tag, число файлов с тегом], отсортировано по убыванию счётчика
  const [data] = createResource(async (): Promise<[string, number][]> => {
    const meta = await props.api.fileMetadataMany(props.ids);
    const counts = new Map<string, number>();
    for (const m of meta) {
      const fileTags = new Set<string>();
      for (const svc of Object.values(m.tags ?? {})) {
        for (const t of svc.display_tags?.["0"] ?? []) fileTags.add(t);
      }
      for (const t of fileTags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  });

  const rows = () => {
    const f = filter().trim().toLowerCase();
    const rm = removed();
    return (data() ?? []).filter(([t]) => !rm.has(t) && (!f || t.toLowerCase().includes(f)));
  };

  function remove(tag: string) {
    props.onRemove(tag);
    setRemoved((s) => new Set(s).add(tag));
  }

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="tagrm" onClick={(e) => e.stopPropagation()}>
        <div class="tagrm-head">
          <span>Remove tag from {props.ids.length} files</span>
          <button class="close" onClick={props.onClose}>✕</button>
        </div>
        <input
          class="tagrm-filter"
          placeholder="filter…"
          autofocus
          value={filter()}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <Show when={!data.loading} fallback={<div class="loading">Loading…</div>}>
          <ul class="tagrm-list">
            <For each={rows()} fallback={<li class="muted tagrm-empty">No tags</li>}>
              {([tag, n]) => (
                <li
                  class="tagrm-item"
                  title={`remove "${tag}" from ${n} file(s)`}
                  onClick={() => remove(tag)}
                >
                  <TagLabel value={tag} />
                  <span class="tagrm-count">{n}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
