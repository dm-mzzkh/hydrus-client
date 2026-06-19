import { createResource, createSignal, For, Show } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { pushToast } from "../toast";
import { onEscape } from "../util";

/**
 * Окно URL'ов выделения. Тянет хэши + known_urls один раз, даёт добавить исходный URL
 * ко всему набору и удалить любой из известных (со счётчиком файлов). API-вызовы и тосты
 * с undo — внутри; выделение в гриде не трогаем (работаем по зафиксированному снапшоту).
 */
export function UrlsModal(props: { api: HydrusApi; ids: number[]; onClose: () => void }) {
  const [add, setAdd] = createSignal("");
  const [stripped, setStripped] = createSignal<Set<string>>(new Set());
  const [added, setAdded] = createSignal<Map<string, number>>(new Map()); // добавленные за сессию
  onEscape(() => props.onClose());

  const [data] = createResource(async () => {
    const meta = await props.api.fileMetadataMany(props.ids);
    const hashes = meta.map((m) => m.hash).filter(Boolean);
    const counts = new Map<string, number>();
    for (const m of meta) for (const u of m.known_urls ?? []) counts.set(u, (counts.get(u) ?? 0) + 1);
    return { hashes, counts };
  });

  const rows = () => {
    const counts = new Map(data()?.counts ?? []);
    for (const [u, n] of added()) counts.set(u, n); // показываем только что добавленные
    const st = stripped();
    return [...counts.entries()]
      .filter(([u]) => !st.has(u))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };

  function invalidate() {
    props.ids.forEach((id) => props.api.invalidateMetadata(id));
  }

  async function doAdd() {
    const url = add().trim();
    const hs = data()?.hashes ?? [];
    if (!url || !hs.length) return;
    setAdd("");
    setStripped((s) => { const n = new Set(s); n.delete(url); return n; });
    setAdded((m) => new Map(m).set(url, hs.length));
    try {
      await props.api.associateUrl(hs, [url], []);
      invalidate();
      pushToast(`Added URL (${hs.length})`, {
        onUndo: () =>
          void props.api.associateUrl(hs, [], [url]).catch((e) => pushToast(String(e), { kind: "error" })),
      });
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  async function doStrip(url: string) {
    const hs = data()?.hashes ?? [];
    if (!hs.length) return;
    setStripped((s) => new Set(s).add(url));
    try {
      await props.api.associateUrl(hs, [], [url]);
      invalidate();
      pushToast(`Stripped URL (${hs.length})`, {
        onUndo: () =>
          void props.api.associateUrl(hs, [url], []).catch((e) => pushToast(String(e), { kind: "error" })),
      });
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="tagrm" onClick={(e) => e.stopPropagation()}>
        <div class="tagrm-head">
          <span>URLs · {props.ids.length} files</span>
          <button class="close" onClick={props.onClose}>✕</button>
        </div>
        <div class="urls-add">
          <input
            placeholder="https://… add source url to all"
            value={add()}
            autofocus
            onInput={(e) => setAdd(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doAdd(); }}
          />
          <button onClick={() => void doAdd()}>+</button>
        </div>
        <Show when={!data.loading} fallback={<div class="loading">Loading…</div>}>
          <ul class="tagrm-list">
            <For each={rows()} fallback={<li class="muted tagrm-empty">No known URLs</li>}>
              {([url, n]) => (
                <li class="urls-item">
                  <a class="urls-link" href={url} target="_blank" rel="noreferrer">{url}</a>
                  <span class="tagrm-count">{n}</span>
                  <button class="urls-x" title="strip from selection" onClick={() => void doStrip(url)}>✕</button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
