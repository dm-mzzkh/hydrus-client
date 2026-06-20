import { batch as txn, createEffect, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { zip } from "fflate";
import { DEFAULTS, loadSettings, saveSettings, type Settings } from "./config";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./theme";
import { muted, toggleMuted } from "./prefs";
import { pushToast } from "./toast";
import { HydrusApi, type ServiceInfo } from "./api/hydrus";
import { SearchBar } from "./components/SearchBar";
import { Toaster } from "./components/Toaster";
import { Thumb } from "./components/Thumb";
import { VirtualGrid } from "./components/VirtualGrid";
import { FileViewer } from "./components/FileViewer";
import { Duplicates } from "./components/Duplicates";
import { ImportView } from "./components/ImportView";
import { SelectionBar, ContextMenu, type SelectionActions } from "./components/SelectionMenu";
import { RemoveTagsModal } from "./components/RemoveTagsModal";
import { UrlsModal } from "./components/UrlsModal";
import { NoteModal } from "./components/NoteModal";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { RelationshipsModal } from "./components/RelationshipsModal";

export function App() {
  const [settings, setSettings] = createSignal<Settings | null>(loadSettings());

  return (
    <>
      <Show when={settings()} fallback={<SettingsForm onSave={setSettings} />}>
        {(s) => <Main settings={s()} onEditSettings={() => setSettings(null)} />}
      </Show>
      <Toaster />
    </>
  );
}

interface HashState {
  tags: string[];
  sortType: number;
  sortAsc: boolean;
  domains: string[];
  fileDomain: string | null;
  open: number | null;
}

function parseHash(): HashState | null {
  const h = location.hash.replace(/^#/, "");
  if (!h) return null;
  const p = new URLSearchParams(h);
  const q = p.get("q");
  if (q == null) return null;
  const tags = q.split(",").map((t) => t.trim()).filter(Boolean);
  if (!tags.length) return null;
  return {
    tags,
    sortType: Number(p.get("s") ?? 2),
    sortAsc: p.get("a") === "1",
    domains: (p.get("d") ?? "").split(",").filter(Boolean),
    fileDomain: p.get("f") || null,
    open: p.has("i") ? Number(p.get("i")) : null,
  };
}

function writeHash(s: HashState): void {
  const p = new URLSearchParams();
  p.set("q", s.tags.join(","));
  if (s.sortType !== 2) p.set("s", String(s.sortType));
  if (s.sortAsc) p.set("a", "1");
  if (s.domains.length) p.set("d", s.domains.join(","));
  if (s.fileDomain) p.set("f", s.fileDomain);
  if (s.open != null) p.set("i", String(s.open));
  history.replaceState(null, "", "#" + p.toString());
}

/** Подмножество file_sort_type из доки Client API. */
const SORTS: [number, string][] = [
  [2, "Import time"],
  [0, "File size"],
  [4, "Random"],
  [9, "Num tags"],
  [1, "Duration"],
  [5, "Width"],
  [6, "Height"],
  [8, "Num pixels"],
  [14, "Modified time"],
  [18, "Last viewed"],
];

function Main(props: { settings: Settings; onEditSettings: () => void }) {
  const api = new HydrusApi(props.settings);
  const [fileIds, setFileIds] = createSignal<number[]>([]);
  const [selected, setSelected] = createSignal<number | null>(null); // индекс в fileIds
  const [columns, setColumns] = createSignal(1);
  const [theme, setTheme] = createSignal<Theme>(loadTheme());
  const [busy, setBusy] = createSignal(false);
  const [dupesOpen, setDupesOpen] = createSignal(false);
  const [importOpen, setImportOpen] = createSignal(false);

  function toggleTheme() {
    const t: Theme = theme() === "dark" ? "light" : "dark";
    setTheme(t);
    applyTheme(t);
    saveTheme(t);
  }
  const [error, setError] = createSignal<string | null>(null);
  const [lastTags, setLastTags] = createSignal<string[] | null>(null);
  const [query, setQuery] = createSignal(""); // текст поиска (управляемый)

  // мультивыбор в гриде (индексы) + батч
  const [sel, setSel] = createSignal<Set<number>>(new Set());
  const [ctxMenu, setCtxMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [selectMode, setSelectMode] = createSignal(false); // S: клик выделяет вместо открытия
  const [removeTags, setRemoveTags] = createSignal<number[] | null>(null); // снапшот для окна remove-tag
  const [urlsIds, setUrlsIds] = createSignal<number[] | null>(null); // снапшот для окна URL
  const [noteIds, setNoteIds] = createSignal<number[] | null>(null); // снапшот для окна заметки
  const [permDelIds, setPermDelIds] = createSignal<number[] | null>(null); // снапшот для permanent delete
  const [relIds, setRelIds] = createSignal<number[] | null>(null); // снапшот для окна отношений
  let lastClicked = -1;

  // сортировка и скоуп
  const [sortType, setSortType] = createSignal(2); // import time
  const [sortAsc, setSortAsc] = createSignal(false); // newest first
  const [domains, setDomains] = createSignal<string[]>([]); // выбранные тег-домены; [] = all
  const [domainsOpen, setDomainsOpen] = createSignal(false);
  const [fileDomain, setFileDomain] = createSignal<string | null>(null); // файловый домен; null = all my files

  const [services] = createResource<Record<string, ServiceInfo>>(() =>
    api.services().catch(() => ({})),
  );
  const tagServices = () =>
    Object.values(services() ?? {}).filter((s) => s.type === 0 || s.type === 5);

  // файловые домены для селектора: type 2 = локальный домен («my files»), 14 = trash.
  // Дефолт («all my files») — пустое значение, отдаём без file_service_key.
  const fileServices = () =>
    Object.values(services() ?? {})
      .filter((s) => s.type === 2 || s.type === 14)
      .sort((a, b) => a.type - b.type);

  // ключ корзины (type 14) и признак, что сейчас просматриваем именно её
  const trashKey = () => Object.values(services() ?? {}).find((s) => s.type === 14)?.service_key;
  const inTrash = () => !!trashKey() && fileDomain() === trashKey();
  // «hydrus local file storage» (type 15) — удаление отсюда стирает файл физически
  const storageKey = () => Object.values(services() ?? {}).find((s) => s.type === 15)?.service_key;

  // один домен → точный tag_service_key, иначе all known tags
  const scopeKey = () => (domains().length === 1 ? domains()[0] : undefined);

  function toggleDomain(key: string) {
    setDomains((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]));
  }

  const domainLabel = () => {
    const d = domains();
    if (d.length === 0) return "All tags";
    if (d.length === 1) return services()?.[d[0]]?.name ?? "1 domain";
    return `${d.length} domains`;
  };

  // первый локальный тег-сервис (type 5) — куда добавлять теги по умолчанию
  const localTagService = () => Object.values(services() ?? {}).find((s) => s.type === 5)?.service_key;

  // ---- мультивыбор ----
  const clearSel = () => setSel(new Set<number>());

  function onCellClick(i: number, e: MouseEvent) {
    if (e.shiftKey && lastClicked >= 0) {
      const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
      const next = new Set(sel());
      for (let k = a; k <= b; k++) next.add(k);
      setSel(next);
    } else if (e.ctrlKey || e.metaKey || selectMode()) {
      // ctrl/meta или режим выделения (S) → переключить выделение, не открывая
      const next = new Set(sel());
      next.has(i) ? next.delete(i) : next.add(i);
      setSel(next);
      lastClicked = i;
    } else {
      lastClicked = i;
      setSelected(i); // открыть просмотрщик; выделение сохраняем
    }
  }

  // правый клик: если ячейка не выделена — выделяем только её (как в Hydrus), затем меню
  function onCellContext(i: number, e: MouseEvent) {
    e.preventDefault();
    if (!sel().has(i)) {
      setSel(new Set([i]));
      lastClicked = i;
    }
    setCtxMenu({ x: e.clientX, y: e.clientY });
  }

  const selectAll = () => setSel(new Set(fileIds().map((_, i) => i)));
  const invert = () =>
    setSel((s) => new Set(fileIds().map((_, i) => i).filter((i) => !s.has(i))));

  // S → переключить режим выделения. Только когда вьюер/модалки закрыты и фокус не в поле ввода
  // (вьюер сам вешает KeyS на «вниз», поэтому при открытом вьюере игнорируем).
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyS" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (selected() !== null || dupesOpen() || importOpen() || ctxMenu()) return;
      if (removeTags() || urlsIds() || noteIds() || permDelIds() || relIds()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      setSelectMode((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const selIds = () =>
    [...sel()].map((i) => fileIds()[i]).filter((x): x is number => x !== undefined);

  async function batch<T = void>(
    label: string,
    apply: (ids: number[]) => Promise<T>,
    undo?: (ids: number[], data: T) => Promise<void>,
    opts?: { ids?: number[]; keepSelection?: boolean },
  ) {
    const ids = opts?.ids ?? selIds();
    if (!ids.length) return;
    if (!opts?.keepSelection) clearSel();
    try {
      const data = await apply(ids);
      pushToast(`${label} (${ids.length})`, {
        onUndo: undo
          ? () => void undo(ids, data).catch((e) => pushToast(String(e), { kind: "error" }))
          : undefined,
      });
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  function addBatchTag(t: string) {
    const tag = t.trim();
    const key = localTagService();
    if (!tag || !key) return;
    void batch(`Tagged "${tag}"`, (ids) => api.addTags(ids, key, [tag]), (ids) => api.addTags(ids, key, [], [tag]));
  }

  // удаление тега из зафиксированного набора файлов (окно remove-tag), выделение не трогаем
  function removeTagFromFiles(ids: number[], t: string) {
    const tag = t.trim();
    const key = localTagService();
    if (!tag || !key || !ids.length) return;
    void batch(
      `Removed "${tag}"`,
      (x) => api.addTags(x, key, [], [tag]),
      (x) => api.addTags(x, key, [tag]),
      { ids, keepSelection: true },
    );
  }

  function openRemoveTags() {
    const ids = selIds();
    if (ids.length) setRemoveTags(ids);
  }
  function openUrls() {
    const ids = selIds();
    if (ids.length) setUrlsIds(ids);
  }
  function openNote() {
    const ids = selIds();
    if (ids.length) setNoteIds(ids);
  }
  function openPermDelete() {
    const ids = selIds();
    if (ids.length) setPermDelIds(ids);
  }
  function openRelationships() {
    const ids = selIds();
    if (ids.length >= 2) setRelIds(ids);
  }

  // вернуть из корзины (undo — снова в корзину)
  function restoreFromTrash() {
    void batch("Restored", (ids) => api.undeleteFiles(ids), (ids) => api.deleteFiles(ids));
  }

  // физическое удаление (из storage-домена type 15 — стирает с диска); без undo, затем пере-поиск
  async function doPermanentDelete(ids: number[]) {
    if (!ids.length) return;
    const key = storageKey();
    if (!key) {
      pushToast("No 'all local files' storage service for physical delete", { kind: "error" });
      return;
    }
    try {
      await api.deleteFiles(ids, { fileServiceKey: key, reason: "deleted via web client" });
      pushToast(`Deleted permanently (${ids.length})`);
      const t = lastTags();
      if (t) void runSearch(t);
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  // батч-рейтинг: снимаем прежние значения per-file, при undo восстанавливаем по группам
  function rateBatch(serviceKey: string, _type: number, value: boolean | number | null) {
    void batch(
      "Rated",
      async (ids) => {
        const meta = await api.fileMetadataMany(ids);
        const prior = new Map<number, boolean | number | null>(
          meta.map((m) => [m.file_id, m.ratings?.[serviceKey]?.rating ?? null]),
        );
        await api.setRating(ids, serviceKey, value);
        return prior;
      },
      async (_ids, prior) => {
        const groups = new Map<string, { value: boolean | number | null; ids: number[] }>();
        for (const [id, v] of prior) {
          const k = JSON.stringify(v);
          let g = groups.get(k);
          if (!g) groups.set(k, (g = { value: v, ids: [] }));
          g.ids.push(id);
        }
        for (const g of groups.values()) await api.setRating(g.ids, serviceKey, g.value);
      },
    );
  }

  // экспорт выделения одним .zip (всё в браузере: качаем байты, складываем store-режимом)
  async function exportZip() {
    const ids = selIds();
    if (!ids.length) return;
    pushToast(`Preparing ZIP (${ids.length})…`);
    try {
      const meta = await api.fileMetadataMany(ids);
      const files: Record<string, Uint8Array> = {};
      const queue = [...meta];
      const worker = async () => {
        for (;;) {
          const m = queue.shift();
          if (!m) break;
          const buf = await fetch(api.fileUrl(m.file_id)).then((r) => {
            if (!r.ok) throw new Error(`file ${m.file_id}: ${r.status}`);
            return r.arrayBuffer();
          });
          const ext = (m.ext ?? "").replace(/^\./, "") || "dat";
          files[`${m.hash}.${ext}`] = new Uint8Array(buf);
        }
      };
      await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
      // level 0 (store): медиа уже сжаты, перепаковка только тратила бы время
      const data = await new Promise<Uint8Array>((res, rej) =>
        zip(files, { level: 0 }, (err: Error | null, out: Uint8Array) => (err ? rej(err) : res(out))),
      );
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `hydrus-export-${ids.length}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      pushToast(`Exported ${Object.keys(files).length} files`);
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  // копирование хэшей / known_urls выделения; selection не сбрасываем
  async function copySelection(kind: "hashes" | "urls") {
    const ids = selIds();
    if (!ids.length) return;
    try {
      const meta = await api.fileMetadataMany(ids);
      const lines =
        kind === "hashes"
          ? meta.map((m) => m.hash).filter(Boolean)
          : [...new Set(meta.flatMap((m) => m.known_urls ?? []))];
      if (!lines.length) {
        pushToast(kind === "urls" ? "No URLs on selection" : "No hashes");
        return;
      }
      await navigator.clipboard.writeText(lines.join("\n"));
      pushToast(`Copied ${lines.length} ${kind}`);
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  const selActions: SelectionActions = {
    archive: () => batch("Archived", (ids) => api.archiveFiles(ids), (ids) => api.unarchiveFiles(ids)),
    inbox: () => batch("Moved to inbox", (ids) => api.unarchiveFiles(ids), (ids) => api.archiveFiles(ids)),
    trash: () => batch("Trashed", (ids) => api.deleteFiles(ids), (ids) => api.undeleteFiles(ids)),
    addTag: addBatchTag,
    openRemoveTags,
    rate: rateBatch,
    associateUrls: openUrls,
    setNote: openNote,
    setRelationships: openRelationships,
    restoreFromTrash,
    deletePermanently: openPermDelete,
    copyHashes: () => void copySelection("hashes"),
    copyUrls: () => void copySelection("urls"),
    exportZip: () => void exportZip(),
    selectAll,
    invert,
    clear: clearSel,
  };

  // клик по тегу во вьюере → новый поиск по нему
  function searchTag(tag: string) {
    setSelected(null);
    setQuery(tag);
    void runSearch([tag]);
  }

  // префетч видимого медиа (localhost — дёшево): картинки целиком, видео — начало ~2с
  const prefetched = new Set<number>();
  let pfQueue: number[] = [];
  let pfActive = 0;
  let pfTimer: ReturnType<typeof setTimeout> | undefined;
  const PF_MAX = 4;

  function onVisible(indices: number[]) {
    clearTimeout(pfTimer);
    pfTimer = setTimeout(() => {
      const ids = fileIds();
      for (const i of indices) {
        const id = ids[i];
        if (id === undefined || prefetched.has(id)) continue;
        prefetched.add(id);
        pfQueue.push(id);
      }
      pumpPrefetch();
    }, 150);
  }

  function pumpPrefetch() {
    while (pfActive < PF_MAX && pfQueue.length) {
      const id = pfQueue.shift()!;
      pfActive++;
      prefetchOne(id).finally(() => {
        pfActive--;
        pumpPrefetch();
      });
    }
  }

  async function prefetchOne(id: number) {
    try {
      const m = await api.basicMetadata(id);
      const url = api.fileUrl(id);
      if ((m.mime ?? "").startsWith("video")) await prefetchVideoStart(url);
      else await prefetchImage(url);
    } catch {
      /* битый файл/мета — пропускаем */
    }
  }

  function prefetchImage(url: string) {
    return new Promise<void>((res) => {
      const im = new Image();
      im.onload = im.onerror = () => res();
      im.src = url;
    });
  }

  function prefetchVideoStart(url: string) {
    // буферим начало detached-видео (no-cors), обрываем через 2с
    return new Promise<void>((res) => {
      const v = document.createElement("video");
      v.preload = "auto";
      v.muted = true;
      const done = () => {
        v.removeAttribute("src");
        v.load();
        res();
      };
      v.oncanplaythrough = done;
      v.onerror = done;
      setTimeout(done, 2000);
      v.src = url;
    });
  }

  async function runSearch(tags: string[]) {
    setLastTags(tags);
    prefetched.clear();
    pfQueue = [];
    clearSel();
    lastClicked = -1;
    setBusy(true);
    setError(null);
    const opts = { sortType: sortType(), sortAsc: sortAsc(), fileServiceKey: fileDomain() ?? undefined };
    try {
      const keys = domains();
      let ids: number[];
      if (keys.length <= 1 || keys.length === tagServices().length) {
        // один домен, либо все → один запрос с точной сортировкой
        ids = await api.searchFiles(tags, { ...opts, tagServiceKey: keys.length === 1 ? keys[0] : undefined });
      } else {
        // подмножество доменов → union по-доменно (API не скоупит на subset одним вызовом)
        const lists = await Promise.all(keys.map((k) => api.searchFiles(tags, { ...opts, tagServiceKey: k })));
        const seen = new Set<number>();
        ids = [];
        for (const l of lists) for (const id of l) if (!seen.has(id)) (seen.add(id), ids.push(id));
      }
      setFileIds(ids);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  // смена сортировки/скоупа → перезапуск последнего поиска (skipNextAuto гасит дубль при restore)
  let skipNextAuto = false;
  createEffect(
    on([sortType, sortAsc, domains, fileDomain], () => {
      if (skipNextAuto) {
        skipNextAuto = false;
        return;
      }
      const t = lastTags();
      if (t) void runSearch(t);
    }, { defer: true }),
  );

  // восстановление состояния из URL-хэша при загрузке
  onMount(() => {
    const st = parseHash();
    if (!st) return;
    skipNextAuto =
      st.sortType !== 2 || st.sortAsc !== false || st.domains.length > 0 || st.fileDomain != null;
    txn(() => {
      setSortType(st.sortType);
      setSortAsc(st.sortAsc);
      setDomains(st.domains);
      setFileDomain(st.fileDomain);
      setQuery(st.tags.join(", "));
    });
    void runSearch(st.tags).then(() => {
      if (st.open != null && st.open >= 0 && st.open < fileIds().length) setSelected(st.open);
    });
  });

  // запись состояния в URL (после первого поиска)
  createEffect(() => {
    const tags = lastTags();
    if (!tags) return;
    writeHash({
      tags,
      sortType: sortType(),
      sortAsc: sortAsc(),
      domains: domains(),
      fileDomain: fileDomain(),
      open: selected(),
    });
  });

  return (
    <Show
      when={!importOpen()}
      fallback={
        <ImportView
          api={api}
          onBack={(imported) => {
            setImportOpen(false);
            const t = lastTags();
            if (imported > 0 && t) void runSearch(t);
          }}
        />
      }
    >
    <div class="app" classList={{ "select-mode": selectMode() }}>
      <header>
        <SearchBar
          api={api}
          busy={busy()}
          onSubmit={runSearch}
          tagServiceKey={scopeKey()}
          query={query()}
          onQueryChange={setQuery}
        />
        <select
          class="ctl"
          value={String(sortType())}
          onChange={(e) => setSortType(Number(e.currentTarget.value))}
        >
          <For each={SORTS}>{([v, label]) => <option value={v}>{label}</option>}</For>
        </select>
        <button
          class="ctl dir"
          title="Sort direction"
          onClick={() => setSortAsc((a) => !a)}
        >
          {sortAsc() ? "↑" : "↓"}
        </button>
        <Show when={tagServices().length}>
          <div class="domains">
            <button class="ctl" title="Tag domains" onClick={() => setDomainsOpen((o) => !o)}>
              {domainLabel()} ▾
            </button>
            <Show when={domainsOpen()}>
              <div class="backdrop" onClick={() => setDomainsOpen(false)} />
              <ul class="domain-menu">
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={domains().length === 0}
                      onChange={() => setDomains([])}
                    />
                    All tags
                  </label>
                </li>
                <For each={tagServices()}>
                  {(s) => (
                    <li>
                      <label>
                        <input
                          type="checkbox"
                          checked={domains().includes(s.service_key)}
                          onChange={() => toggleDomain(s.service_key)}
                        />
                        {s.name}
                      </label>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
        <Show when={fileServices().length}>
          <select
            class="ctl"
            title="File domain"
            value={fileDomain() ?? ""}
            onChange={(e) => setFileDomain(e.currentTarget.value || null)}
          >
            <option value="">All my files</option>
            <For each={fileServices()}>{(s) => <option value={s.service_key}>{s.name}</option>}</For>
          </select>
        </Show>
        <span class="count">{fileIds().length} files</span>
        <button
          class="gear"
          classList={{ on: selectMode() }}
          title="Select mode (S) — click thumbnails to select instead of open"
          onClick={() => setSelectMode((v) => !v)}
        >
          ▣
        </button>
        <button class="gear" title="Import via gallery-dl" onClick={() => setImportOpen(true)}>
          ＋
        </button>
        <button
          class="gear"
          title="Find duplicates in this search"
          disabled={!lastTags()}
          onClick={() => setDupesOpen(true)}
        >
          ≊
        </button>
        <button class="gear" title="Toggle preview sound" onClick={toggleMuted}>
          {muted() ? "🔇" : "🔊"}
        </button>
        <button class="gear" title="Toggle theme" onClick={toggleTheme}>
          {theme() === "dark" ? "☀" : "☾"}
        </button>
        <button class="gear" title="Settings" onClick={props.onEditSettings}>
          ⚙
        </button>
      </header>

      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>

      <Show when={sel().size}>
        <SelectionBar
          count={sel().size}
          api={api}
          tagServiceKey={localTagService()}
          inTrash={inTrash()}
          multi={sel().size >= 2}
          services={services()}
          a={selActions}
        />
      </Show>

      <main>
        <VirtualGrid
          count={fileIds().length}
          cellSize={180}
          gap={8}
          onColumns={setColumns}
          onVisible={onVisible}
          renderCell={(i) => (
            <Thumb
              api={api}
              id={fileIds()[i]}
              selected={sel().has(i)}
              onClick={(e) => onCellClick(i, e)}
              onContextMenu={(e) => onCellContext(i, e)}
            />
          )}
        />
      </main>

      <Show when={ctxMenu()}>
        {(m) => (
          <ContextMenu
            x={m().x}
            y={m().y}
            api={api}
            tagServiceKey={localTagService()}
            inTrash={inTrash()}
            multi={sel().size >= 2}
            services={services()}
            a={selActions}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </Show>

      <Show when={removeTags()}>
        {(ids) => (
          <RemoveTagsModal
            api={api}
            ids={ids()}
            onRemove={(tag) => removeTagFromFiles(ids(), tag)}
            onClose={() => setRemoveTags(null)}
          />
        )}
      </Show>

      <Show when={urlsIds()}>
        {(ids) => <UrlsModal api={api} ids={ids()} onClose={() => setUrlsIds(null)} />}
      </Show>

      <Show when={noteIds()}>
        {(ids) => <NoteModal api={api} ids={ids()} onClose={() => setNoteIds(null)} />}
      </Show>

      <Show when={permDelIds()}>
        {(ids) => (
          <ConfirmDialog
            title={`Permanently delete ${ids().length} files?`}
            message="This physically removes them from disk and cannot be undone."
            confirmLabel="Delete"
            danger
            onConfirm={() => void doPermanentDelete(ids())}
            onClose={() => setPermDelIds(null)}
          />
        )}
      </Show>

      <Show when={relIds()}>
        {(ids) => (
          <RelationshipsModal
            api={api}
            ids={ids()}
            onClose={(changed) => {
              setRelIds(null);
              const t = lastTags();
              if (changed && t) void runSearch(t);
            }}
          />
        )}
      </Show>

      <Show when={selected() !== null}>
        <FileViewer
          api={api}
          fileIds={fileIds()}
          index={selected()!}
          onIndex={setSelected}
          columns={columns()}
          tagService={localTagService()}
          onSearchTag={searchTag}
          onClose={() => setSelected(null)}
        />
      </Show>

      <Show when={dupesOpen()}>
        <Duplicates
          api={api}
          tags={lastTags() ?? []}
          tagServiceKey={scopeKey()}
          onClose={(changed) => {
            setDupesOpen(false);
            const t = lastTags();
            if (changed && t) void runSearch(t);
          }}
        />
      </Show>

    </div>
    </Show>
  );
}

function SettingsForm(props: { onSave: (s: Settings) => void }) {
  const existing = loadSettings();
  const [baseUrl, setBaseUrl] = createSignal(existing?.baseUrl ?? DEFAULTS.baseUrl);
  const [accessKey, setAccessKey] = createSignal(existing?.accessKey ?? DEFAULTS.accessKey);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const s: Settings = { baseUrl: baseUrl().trim(), accessKey: accessKey().trim() };
    try {
      if (!(await new HydrusApi(s).verify())) {
        throw new Error("Could not connect — check the URL and access key.");
      }
      saveSettings(s);
      props.onSave(s);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="settings" onSubmit={submit}>
      <h1>Hydrus Client</h1>
      <label>
        Client API URL
        <input value={baseUrl()} onInput={(e) => setBaseUrl(e.currentTarget.value)} />
      </label>
      <label>
        Access Key
        <input
          type="password"
          value={accessKey()}
          onInput={(e) => setAccessKey(e.currentTarget.value)}
        />
      </label>
      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>
      <button type="submit" disabled={busy()}>
        {busy() ? "Checking…" : "Connect"}
      </button>
      <p class="hint">
        Enable the Client API in Hydrus: <em>services → manage services → client api</em>.
        Create an access key with permission to search and view files, and turn on “support CORS”.
      </p>
    </form>
  );
}
