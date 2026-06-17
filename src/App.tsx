import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { DEFAULTS, loadSettings, saveSettings, type Settings } from "./config";
import { HydrusApi, type ServiceInfo } from "./api/hydrus";
import { SearchBar } from "./components/SearchBar";
import { VirtualGrid } from "./components/VirtualGrid";
import { FileViewer } from "./components/FileViewer";

export function App() {
  const [settings, setSettings] = createSignal<Settings | null>(loadSettings());

  return (
    <Show when={settings()} fallback={<SettingsForm onSave={setSettings} />}>
      {(s) => <Main settings={s()} onEditSettings={() => setSettings(null)} />}
    </Show>
  );
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
  const [selected, setSelected] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [lastTags, setLastTags] = createSignal<string[] | null>(null);

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

  async function runSearch(tags: string[]) {
    setLastTags(tags);
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

  // смена сортировки/скоупа → перезапуск последнего поиска
  createEffect(
    on([sortType, sortAsc, domains], () => {
      const t = lastTags();
      if (t) void runSearch(t);
    }, { defer: true }),
  );

  return (
    <div class="app">
      <header>
        <SearchBar
          api={api}
          busy={busy()}
          onSubmit={runSearch}
          tagServiceKey={scopeKey()}
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
        <button class="gear" title="Settings" onClick={props.onEditSettings}>
          ⚙
        </button>
      </header>

      <Show when={error()}>
        <div class="error">{error()}</div>
      </Show>

      <main>
        <VirtualGrid
          count={fileIds().length}
          cellSize={180}
          gap={8}
          renderCell={(i) => {
            const id = fileIds()[i];
            return (
              <img
                class="thumb"
                src={api.thumbnailUrl(id)}
                loading="lazy"
                decoding="async"
                onClick={() => setSelected(id)}
              />
            );
          }}
        />
      </main>

      <Show when={selected() !== null}>
        <FileViewer api={api} fileId={selected()!} onClose={() => setSelected(null)} />
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
