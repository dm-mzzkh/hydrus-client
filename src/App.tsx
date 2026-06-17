import { createSignal, Show } from "solid-js";
import { DEFAULTS, loadSettings, saveSettings, type Settings } from "./config";
import { HydrusApi } from "./api/hydrus";
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

function Main(props: { settings: Settings; onEditSettings: () => void }) {
  const api = new HydrusApi(props.settings);
  const [query, setQuery] = createSignal("");
  const [fileIds, setFileIds] = createSignal<number[]>([]);
  const [selected, setSelected] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function search(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const raw = query().trim();
      const tags = raw
        ? raw.split(",").map((t) => t.trim()).filter(Boolean)
        : ["system:everything"];
      setFileIds(await api.searchFiles(tags));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="app">
      <header>
        <form onSubmit={search}>
          <input
            placeholder="теги через запятую, напр. character:samus, blue eyes"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button type="submit" disabled={busy()}>
            {busy() ? "…" : "Поиск"}
          </button>
        </form>
        <span class="count">{fileIds().length} файлов</span>
        <button class="gear" title="Настройки" onClick={props.onEditSettings}>
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
        throw new Error("Не удалось подключиться — проверь адрес и ключ.");
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
        Адрес Client API
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
        {busy() ? "Проверка…" : "Подключиться"}
      </button>
      <p class="hint">
        Включи Client API в Hydrus: <em>services → manage services → client api</em>.
        Создай ключ доступа с правами на поиск и просмотр файлов и включи «support CORS».
      </p>
    </form>
  );
}
