import { batch as txn, createEffect, createResource, createSignal, For, on, onMount, Show } from "solid-js";
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
    open: p.has("i") ? Number(p.get("i")) : null,
  };
}

function writeHash(s: HashState): void {
  const p = new URLSearchParams();
  p.set("q", s.tags.join(","));
  if (s.sortType !== 2) p.set("s", String(s.sortType));
  if (s.sortAsc) p.set("a", "1");
  if (s.domains.length) p.set("d", s.domains.join(","));
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
  const [batchTag, setBatchTag] = createSignal("");
  let lastClicked = -1;

  // сортировка и скоуп
  const [sortType, setSortType] = createSignal(2); // import time
  const [sortAsc, setSortAsc] = createSignal(false); // newest first
  const [domains, setDomains] = createSignal<string[]>([]); // выбранные тег-домены; [] = all
  const [domainsOpen, setDomainsOpen] = createSignal(false);

  const [services] = createResource<Record<string, ServiceInfo>>(() =>
    api.services().catch(() => ({})),
  );
  const tagServices = () =>
    Object.values(services() ?? {}).filter((s) => s.type === 0 || s.type === 5);

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
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(sel());
      next.has(i) ? next.delete(i) : next.add(i);
      setSel(next);
      lastClicked = i;
    } else {
      if (sel().size) clearSel();
      lastClicked = i;
      setSelected(i); // открыть просмотрщик
    }
  }

  const selIds = () =>
    [...sel()].map((i) => fileIds()[i]).filter((x): x is number => x !== undefined);

  async function batch(
    label: string,
    apply: (ids: number[]) => Promise<void>,
    undo?: (ids: number[]) => Promise<void>,
  ) {
    const ids = selIds();
    if (!ids.length) return;
    clearSel();
    try {
      await apply(ids);
      pushToast(`${label} (${ids.length})`, {
        onUndo: undo ? () => void undo(ids).catch((e) => pushToast(String(e), { kind: "error" })) : undefined,
      });
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  async function addBatchTag() {
    const t = batchTag().trim();
    const key = localTagService();
    if (!t || !key) return;
    setBatchTag("");
    await batch(`Tagged "${t}"`, (ids) => api.addTags(ids, key, [t]), (ids) => api.addTags(ids, key, [], [t]));
  }

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
    const opts = { sortType: sortType(), sortAsc: sortAsc() };
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
    on([sortType, sortAsc, domains], () => {
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
    skipNextAuto = st.sortType !== 2 || st.sortAsc !== false || st.domains.length > 0;
    txn(() => {
      setSortType(st.sortType);
      setSortAsc(st.sortAsc);
      setDomains(st.domains);
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
    writeHash({ tags, sortType: sortType(), sortAsc: sortAsc(), domains: domains(), open: selected() });
  });

  return (
    <div class="app">
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
        <span class="count">{fileIds().length} files</span>
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
        <div class="batchbar">
          <span>{sel().size} selected</span>
          <button onClick={() => batch("Archived", (ids) => api.archiveFiles(ids), (ids) => api.unarchiveFiles(ids))}>
            Archive
          </button>
          <button onClick={() => batch("Moved to inbox", (ids) => api.unarchiveFiles(ids), (ids) => api.archiveFiles(ids))}>
            Inbox
          </button>
          <button onClick={() => batch("Trashed", (ids) => api.deleteFiles(ids), (ids) => api.undeleteFiles(ids))}>
            Trash
          </button>
          <input
            placeholder="add tag…"
            value={batchTag()}
            onInput={(e) => setBatchTag(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && addBatchTag()}
          />
          <button class="spacer" onClick={clearSel}>Clear</button>
        </div>
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
            />
          )}
        />
      </main>

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
    </div>
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
