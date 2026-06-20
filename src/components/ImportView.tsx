import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { TagInput } from "./TagInput";
import { TagLabel } from "./TagLabel";
import { VirtualList } from "./VirtualList";
import { LocalImport } from "./LocalImport";
import { Lightbox, mediaKind, type LbMeta, type MediaKind } from "./Lightbox";

interface Props {
  api: HydrusApi;
  /** imported = сколько реально залилось в Hydrus (родитель перезапустит поиск, если > 0) */
  onBack: (imported: number) => void;
}

type DbStatus = "new" | "in_db" | "deleted";
interface Item {
  id: number;
  urlIndex: number;
  rangeIndex: number;
  url: string;
  label: string;
  dbStatus: DbStatus;
  dbHash?: string;
  staged: boolean;
}
interface Staged {
  key: string;
  name: string;
  tags: string[];
  urls: string[];
  fileUrl?: string;
  dbStatus?: DbStatus;
  imported: boolean;
  status?: number;
  hash?: string;
  note?: string;
}
interface Snap {
  id: string;
  phase: "enumerating" | "listed" | "downloading" | "done" | "stopped" | "error";
  checking: boolean;
  urls: string[];
  items: Item[];
  itemsRev: number;
  staged: Staged[];
  importing: boolean;
  downloaded: number;
  cachedSkipped: number;
  imported: number;
  failed: number;
  selectedCount: number;
  log: string[];
  error?: string;
}
// сервер может НЕ прислать items (дельта) — тогда держим прошлую копию
type Wire = Omit<Snap, "items"> & { items?: Item[] };
// краткая сводка джоба для менеджера импортов (GET /jobs)
interface JobSummary {
  id: string;
  phase: Snap["phase"];
  checking: boolean;
  importing: boolean;
  label: string;
  urlCount: number;
  items: number;
  staged: number;
  imported: number;
  failed: number;
  createdAt: number;
}

const STATUS_LABEL: Record<number, string> = { 1: "imported", 2: "already in db", 3: "prev. deleted", 4: "failed", 7: "vetoed" };
const DB_LABEL: Record<DbStatus, string> = { new: "new", in_db: "in db", deleted: "deleted" };
const LS_KEY = "gdl-job";
const ITEM_ROW = 84;   // высота строки списка (миниатюра 72 + отступы)
const STAGED_ROW = 76; // высота строки стейджинга (миниатюра 64 + отступы)
const cachedUrl = (key: string) => `/__gallerydl/cached?key=${encodeURIComponent(key)}`;

export function ImportView(props: Props) {
  const [urls, setUrls] = createSignal("");
  const [tagList, setTagList] = createSignal<string[]>([]);
  const [snap, setSnap] = createSignal<Snap | null>(null);
  const [selected, setSelected] = createSignal<Set<number>>(new Set<number>());
  // «добавить, даже если уже в БД / удалён» — форс при импорте (восстановить удалённое)
  const [addAnyway, setAddAnyway] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [cacheMsg, setCacheMsg] = createSignal("");
  const [mode, setMode] = createSignal<"gallery" | "local">("gallery");
  const [managerOpen, setManagerOpen] = createSignal(false);
  const [jobsList, setJobsList] = createSignal<JobSummary[]>([]);
  const [lb, setLb] = createSignal<{ urls: string[]; metas?: LbMeta[]; kinds?: MediaKind[]; keys?: string[]; index: number } | null>(null);
  let importedCount = 0;
  let jobId = "";
  let lastItemsRev = -1;  // последняя версия items, что у нас есть (для дельта-опроса)
  let selFinal = false;   // финальный дефолт-выбор (new-only) уже применён
  let selTouched = false; // пользователь трогал выбор руками → не перетираем
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  const phase = () => snap()?.phase;
  const items = () => snap()?.items ?? [];
  const staged = () => snap()?.staged ?? [];
  const reviewing = () => { const p = phase(); return p === "downloading" || p === "done" || p === "stopped" || p === "error"; };
  const active = () => phase() === "enumerating" || phase() === "downloading" || !!snap()?.checking || !!snap()?.importing;

  // ---- опрос /status (переживает reload: джоб живёт на сервере) ----
  async function refresh(): Promise<boolean> {
    if (!jobId) return false;
    try {
      const res = await fetch(`/__gallerydl/status?jobId=${encodeURIComponent(jobId)}&itemsRev=${lastItemsRev}`);
      if (!res.ok) {
        if (res.status === 404) { localStorage.removeItem(LS_KEY); jobId = ""; setSnap(null); lastItemsRev = -1; selFinal = false; selTouched = false; }
        return false;
      }
      const data = (await res.json()) as Wire;
      // items не прислали → не изменились, держим прошлую копию
      const merged: Snap = { ...data, items: data.items ?? snap()?.items ?? [] };
      lastItemsRev = merged.itemsRev;
      importedCount = Math.max(importedCount, merged.imported); // high-water за всю сессию (для refresh на back)
      setSnap(merged);
      // дефолт-выбор: пока идёт проверка БД — выбираем все; когда закончилась — только «new»
      if (merged.phase === "listed" && !selTouched && !selFinal) {
        if (merged.checking) {
          setSelected(new Set(merged.items.map((it) => it.id)));
        } else {
          setSelected(new Set(merged.items.filter((it) => it.dbStatus === "new").map((it) => it.id)));
          selFinal = true;
        }
      }
      return true;
    } catch { return false; }
  }
  function startPolling() {
    if (pollTimer) return;
    const tick = async () => { pollTimer = undefined; await refresh(); if (active()) pollTimer = setTimeout(tick, 1000); };
    pollTimer = setTimeout(tick, 0);
  }
  function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; } }

  onMount(async () => {
    void fetchJobs();
    const saved = localStorage.getItem(LS_KEY);
    if (saved) { jobId = saved; const ok = await refresh(); if (ok && active()) startPolling(); }
  });
  onCleanup(stopPolling);

  // ---- лайтбокс ----
  const openItem = (i: number) =>
    setLb({
      urls: items().map((it) => (it.dbHash ? props.api.fileUrlByHash(it.dbHash) : it.url)),
      kinds: items().map((it) => mediaKind(it.url)),
      index: i,
    });
  const openStaged = (i: number) =>
    setLb({
      urls: staged().map((s) => cachedUrl(s.key)),
      kinds: staged().map((s) => mediaKind(s.name)),
      metas: staged().map((s) => ({ name: s.name, tags: s.tags, urls: s.urls })),
      keys: staged().map((s) => s.key),
      index: i,
    });

  // ---- правка тегов отдельного staged-файла (по ключу) ----
  function editTagSet(tags: string[], add: string[], remove: string[]): string[] {
    const set = new Set(tags);
    for (const t of remove) set.delete(t);
    for (const t of add) set.add(t);
    return [...set];
  }
  function setStagedTag(key: string, add: string[], remove: string[]) {
    // оптимистично: и список (счётчик тегов), и открытый лайтбокс (сайдбар)
    setSnap((s) => (s ? { ...s, staged: s.staged.map((st) => (st.key === key ? { ...st, tags: editTagSet(st.tags, add, remove) } : st)) } : s));
    setLb((p) => (p && p.keys && p.metas ? { ...p, metas: p.metas.map((m, i) => (p.keys![i] === key ? { ...m, tags: editTagSet(m.tags, add, remove) } : m)) } : p));
    fetch("/__gallerydl/staged-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, key, add, remove }) }).catch(() => {});
  }

  // ---- «теги для всех» на лету (влияет на файлы, что застейджатся ПОСЛЕ правки) ----
  function syncTags(next: string[]) {
    if (jobId && phase() && phase() !== "done" && phase() !== "stopped" && phase() !== "error") {
      fetch("/__gallerydl/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, tags: next }) }).catch(() => {});
    }
  }
  const addTag = (t: string) => { const v = t.trim(); if (!v || tagList().includes(v)) return; const next = [...tagList(), v]; setTagList(next); syncTags(next); };
  const removeTag = (t: string) => { const next = tagList().filter((x) => x !== t); setTagList(next); syncTags(next); };
  // редактор «теги для всех» — переиспользуется на старте и в фазах listed/downloading
  const tagsField = () => (
    <>
      <Show when={tagList().length}>
        <div class="imp-chips">
          <For each={tagList()}>{(t) => <span class="chip"><TagLabel value={t} /><button class="chip-x" onClick={() => removeTag(t)} aria-label="Remove">×</button></span>}</For>
        </div>
      </Show>
      <TagInput api={props.api} placeholder="add tag…" onPick={addTag} />
    </>
  );

  // ---- фаза 1: получить список ----
  async function getList() {
    const list = urls().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!list.length || busy()) return;
    setBusy(true);
    selFinal = false; selTouched = false; lastItemsRev = -1;
    setSelected(new Set<number>());
    jobId = crypto.randomUUID();
    localStorage.setItem(LS_KEY, jobId);
    setSnap({ id: jobId, phase: "enumerating", checking: false, urls: list, items: [], itemsRev: 0, staged: [], importing: false, downloaded: 0, cachedSkipped: 0, imported: 0, failed: 0, selectedCount: 0, log: [] });
    try {
      const res = await fetch("/__gallerydl/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ urls: list, tags: tagList(), jobId }) });
      if (!res.ok) throw new Error(`runner error ${res.status} — is the dev server running?`);
      startPolling();
    } catch (e) {
      setSnap((s) => (s ? { ...s, phase: "error", error: String(e) } : s));
    } finally { setBusy(false); }
  }

  // ---- фаза 2: скачать выбранные в кэш (без импорта) ----
  async function download() {
    if (busy() || phase() !== "listed") return;
    const ids = [...selected()];
    if (!ids.length) return;
    setBusy(true);
    try {
      await fetch("/__gallerydl/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, ids }) });
      setSnap((s) => (s ? { ...s, phase: "downloading", selectedCount: ids.length } : s));
      startPolling();
    } finally { setBusy(false); }
  }

  // ---- «скачать и импорт»: качаем выбранные в кэш и сразу импортируем каждый ----
  async function downloadImport() {
    if (busy() || phase() !== "listed") return;
    const ids = [...selected()];
    if (!ids.length) return;
    setBusy(true);
    try {
      await fetch("/__gallerydl/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, ids, autoImport: true, importForce: addAnyway() }) });
      setSnap((s) => (s ? { ...s, phase: "downloading", importing: true, selectedCount: ids.length } : s));
      startPolling();
    } finally { setBusy(false); }
  }

  // ---- фаза 3: импортировать staged-файлы в Hydrus ----
  async function importStaged(keys: string[]) {
    if (!keys.length || !jobId || snap()?.importing) return;
    await fetch("/__gallerydl/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, keys, force: addAnyway() }) });
    await refresh();
    startPolling();
  }
  const remainingStaged = () => staged().filter((s) => !s.imported);

  function stop() {
    fetch("/__gallerydl/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId }) }).catch(() => {});
  }
  function newImport() {
    stopPolling(); localStorage.removeItem(LS_KEY); jobId = ""; lastItemsRev = -1; selFinal = false; selTouched = false;
    setSnap(null); setSelected(new Set<number>());
    setMode("gallery"); setManagerOpen(false);
  }

  // ---- менеджер импортов: список всех джобов на сервере ----
  async function fetchJobs() {
    try {
      const res = await fetch("/__gallerydl/jobs");
      if (res.ok) setJobsList(((await res.json()) as { jobs: JobSummary[] }).jobs ?? []);
    } catch { /* dev-сервер не запущен */ }
  }
  function toggleManager() {
    const open = !managerOpen();
    setManagerOpen(open);
    if (open) void fetchJobs();
  }
  async function openJob(id: string) {
    stopPolling();
    jobId = id; lastItemsRev = -1; selFinal = false; selTouched = false;
    localStorage.setItem(LS_KEY, id);
    setSnap(null); setSelected(new Set<number>());
    setMode("gallery"); setManagerOpen(false);
    const ok = await refresh();
    if (ok) startPolling();
  }
  async function removeJob(id: string) {
    await fetch("/__gallerydl/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: id }) }).catch(() => {});
    if (id === jobId) newImport();
    void fetchJobs();
  }
  async function clearCache() {
    setCacheMsg("clearing…");
    try { const res = await fetch("/__gallerydl/clear-cache", { method: "POST" }); setCacheMsg(res.ok ? "cache cleared" : `error ${res.status}`); }
    catch (e) { setCacheMsg(`error: ${String(e)}`); }
  }

  // ---- выбор элементов списка ----
  const toggle = (id: number) => { selTouched = true; setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); };
  const selectAll = () => { selTouched = true; setSelected(new Set(items().map((it) => it.id))); };
  const selectNone = () => { selTouched = true; setSelected(new Set<number>()); };
  const hasDbHits = () => items().some((it) => it.dbStatus !== "new") || staged().some((s) => s.dbStatus && s.dbStatus !== "new");

  const back = () => { stopPolling(); props.onBack(importedCount); };

  // подпись статуса staged-строки (с учётом терминальных неудач)
  const stagedStatus = (s: Staged) =>
    s.imported ? (STATUS_LABEL[s.status ?? 1] ?? "imported")
      : s.status === 3 ? "prev. deleted"
      : s.status === 4 ? "failed"
      : s.status === 7 ? "vetoed"
      : "staged";

  return (
    <div class="importview">
      <div class="iv-head">
        <button class="iv-back" onClick={back}>← back</button>
        <strong>Import</strong>
        <div class="iv-modes">
          <button classList={{ active: mode() === "gallery" }} onClick={() => setMode("gallery")}>gallery-dl</button>
          <button classList={{ active: mode() === "local" }} onClick={() => setMode("local")}>local files</button>
        </div>
        <span class="iv-spacer" />
        <button class="iv-mgr" onClick={toggleManager}>imports{jobsList().length ? ` (${jobsList().length})` : ""} ▾</button>
        <Show when={mode() === "gallery" && snap()}>
          <button class="iv-new" onClick={newImport}>new import</button>
        </Show>
      </div>

      {/* менеджер импортов: все джобы на сервере */}
      <Show when={managerOpen()}>
        <div class="iv-manager">
          <div class="iv-toolbar">
            <span class="imp-label">Imports <span class="muted">({jobsList().length})</span></span>
            <span class="iv-spacer" />
            <button onClick={fetchJobs}>refresh</button>
            <button onClick={newImport}>＋ new</button>
          </div>
          <Show when={jobsList().length} fallback={<p class="muted">No import jobs.</p>}>
            <div class="iv-jobs">
              <For each={jobsList()}>
                {(j) => (
                  <div class="iv-job" classList={{ active: j.id === jobId }}>
                    <button class="iv-job-open" onClick={() => openJob(j.id)} title={j.label}>
                      <span class="iv-job-label">{j.label}</span>
                      <span class="muted iv-job-meta">
                        {j.phase}{j.checking ? " · checking" : ""}{j.importing ? " · importing" : ""} · {j.items} items · {j.staged} staged · {j.imported} imp{j.failed ? ` · ${j.failed} fail` : ""}
                      </span>
                    </button>
                    <button class="iv-job-x" onClick={() => removeJob(j.id)} aria-label="Remove">×</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>

      {/* локальный импорт файлов/папок (клиентский, прямо в Hydrus) */}
      <Show when={mode() === "local"}>
        <LocalImport api={props.api} onImported={(n) => { importedCount += n; }} />
      </Show>

      {/* ====== gallery-dl ====== */}
      <Show when={mode() === "gallery"}>
      {/* старт: URL + теги */}
      <Show when={!snap()}>
        <div class="iv-body">
          <label class="imp-field">
            <span class="imp-label">URLs <span class="muted">— one per line</span></span>
            <textarea class="imp-urls" placeholder="" value={urls()} onInput={(e) => setUrls(e.currentTarget.value)} spellcheck={false} />
          </label>
          <div class="imp-field">
            <span class="imp-label">Tags for all <span class="muted">— applied to every imported file</span></span>
            {tagsField()}
          </div>
          <div class="imp-bar">
            <button class="imp-go" onClick={getList} disabled={!urls().trim() || busy()}>Get list</button>
            <span class="iv-spacer" />
            <span class="muted">{cacheMsg()}</span>
            <button onClick={clearCache} title="Erase the download cache (staged files + url→hash map)">clear cache</button>
          </div>
        </div>
      </Show>

      {/* enumerate */}
      <Show when={phase() === "enumerating"}>
        <div class="iv-body">
          <p class="muted">Listing… {items().length ? `(${items().length} found)` : ""}</p>
        </div>
      </Show>

      {/* listed: выбор + статус БД */}
      <Show when={phase() === "listed"}>
        <div class="iv-body">
          <div class="iv-toolbar">
            <span class="imp-label">{items().length} items <span class="muted">· {selected().size} selected</span></span>
            <Show when={snap()?.checking}><span class="muted">· checking db…</span></Show>
            <span class="iv-spacer" />
            <Show when={hasDbHits()}>
              <label class="iv-check" title="Import even if already in Hydrus or was deleted (restores deleted files)">
                <input type="checkbox" checked={addAnyway()} onChange={(e) => setAddAnyway(e.currentTarget.checked)} />
                add anyway
              </label>
            </Show>
            <button onClick={selectAll}>all</button>
            <button onClick={selectNone}>none</button>
            <button onClick={download} disabled={!selected().size || busy()}>Download ({selected().size})</button>
            <button class="imp-go" onClick={downloadImport} disabled={!selected().size || busy()}>Download &amp; import ({selected().size})</button>
          </div>
          <div class="imp-field iv-tags">
            <span class="imp-label">Tags for all <span class="muted">— affects files staged after editing</span></span>
            {tagsField()}
          </div>
          <VirtualList
            class="iv-scroll"
            count={items().length}
            rowHeight={ITEM_ROW}
            renderRow={(idx) => {
              const it = () => items()[idx];
              return (
                <Show when={it()}>
                  {(item) => (
                    <label class="iv-item" classList={{ off: !selected().has(item().id) }}>
                      <input type="checkbox" checked={selected().has(item().id)} onChange={() => toggle(item().id)} />
                      <Show
                        when={!item().dbHash && mediaKind(item().url) === "video"}
                        fallback={
                          <img
                            class="iv-thumb"
                            src={item().dbHash ? props.api.thumbnailUrlByHash(item().dbHash!) : item().url}
                            loading="lazy" decoding="async" referrerpolicy="no-referrer" width={72} height={72}
                            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openItem(idx); }}
                          />
                        }
                      >
                        {/* видео ещё не в Hydrus → первый кадр через <video> (только метаданные) */}
                        <video
                          class="iv-thumb" src={item().url} preload="metadata" muted width={72} height={72}
                          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); openItem(idx); }}
                        />
                      </Show>
                      <span class="iv-name" title={item().url}>{item().label}</span>
                      <span class="iv-badge" classList={{ indb: item().dbStatus === "in_db", del: item().dbStatus === "deleted" }}>{DB_LABEL[item().dbStatus]}</span>
                      <Show when={item().staged}><span class="iv-badge cachedb">cached</span></Show>
                      <span class="muted iv-src">{item().url}</span>
                    </label>
                  )}
                </Show>
              );
            }}
          />
        </div>
      </Show>

      {/* staging review: скачано в кэш, импортируем по кнопке */}
      <Show when={reviewing()}>
        <div class="iv-body">
          <div class="iv-toolbar">
            <span class="imp-label">
              {phase() === "downloading" ? "Downloading" : phase() === "error" ? "Error" : phase() === "stopped" ? "Stopped" : "Staged"}
              <span class="muted"> · {staged().length}{snap()?.selectedCount ? ` / ${snap()!.selectedCount}` : ""}</span>
            </span>
            <span class="iv-spacer" />
            <span class="muted">downloaded {snap()?.downloaded ?? 0} · cached {snap()?.cachedSkipped ?? 0} · imported {snap()?.imported ?? 0}{snap()?.failed ? ` · failed ${snap()!.failed}` : ""}</span>
            <Show when={hasDbHits()}>
              <label class="iv-check" title="Import even if the file is already in Hydrus or was deleted (restores deleted files)">
                <input type="checkbox" checked={addAnyway()} onChange={(e) => setAddAnyway(e.currentTarget.checked)} />
                add anyway
              </label>
            </Show>
            <Show when={phase() === "downloading" || snap()?.importing}>
              <button class="imp-go danger" onClick={stop}>Stop</button>
            </Show>
            <Show when={remainingStaged().length}>
              <button class="imp-go" disabled={snap()?.importing} onClick={() => importStaged(remainingStaged().map((s) => s.key))}>
                {snap()?.importing ? "importing…" : `Import all (${remainingStaged().length})`}
              </button>
            </Show>
          </div>

          <Show when={snap()?.error}><div class="error">{snap()!.error}</div></Show>

          <VirtualList
            class="iv-scroll"
            count={staged().length}
            rowHeight={STAGED_ROW}
            renderRow={(idx) => {
              const s = () => staged()[idx];
              return (
                <Show when={s()}>
                  {(it) => (
                    <div class="imp-file">
                      <Show
                        when={mediaKind(it().name) === "video"}
                        fallback={<img class="imp-thumb clickable" src={cachedUrl(it().key)} loading="lazy" decoding="async" width={64} height={64} onClick={() => openStaged(idx)} />}
                      >
                        <video class="imp-thumb clickable" src={cachedUrl(it().key)} preload="metadata" muted width={64} height={64} onClick={() => openStaged(idx)} />
                      </Show>
                      <span class="imp-name" title={it().name}>{it().name}</span>
                      <span class="muted">{it().tags.length} tags</span>
                      <Show when={it().dbStatus && it().dbStatus !== "new"}>
                        <span class="iv-badge" classList={{ indb: it().dbStatus === "in_db", del: it().dbStatus === "deleted" }}>{DB_LABEL[it().dbStatus!]}</span>
                      </Show>
                      <span class="imp-status" title={it().note || ""} classList={{ ok: it().imported && it().status === 1, dim: it().imported && it().status !== 1, bad: !it().imported && (it().status === 4 || it().status === 7) }}>
                        {stagedStatus(it())}
                      </span>
                      <Show when={!it().imported && it().status !== 7}>
                        <button class="imp-force" disabled={snap()?.importing} onClick={() => importStaged([it().key])}>import</button>
                      </Show>
                    </div>
                  )}
                </Show>
              );
            }}
          />
        </div>
      </Show>

      <Show when={snap()?.log?.length}>
        <details class="imp-adv">
          <summary>Log <span class="muted">({snap()!.log.length})</span></summary>
          <pre class="imp-log">{snap()!.log.join("\n")}</pre>
        </details>
      </Show>
      </Show>{/* ====== /gallery-dl ====== */}

      {/* полноразмерный просмотр (как в галерее): staged — с сайдбаром тегов/источников */}
      <Show when={lb()}>
        <Lightbox
          urls={lb()!.urls} metas={lb()!.metas} kinds={lb()!.kinds} index={lb()!.index}
          api={props.api}
          onAddTag={(i, t) => { const k = lb()?.keys?.[i]; if (k) setStagedTag(k, [t], []); }}
          onRemoveTag={(i, t) => { const k = lb()?.keys?.[i]; if (k) setStagedTag(k, [], [t]); }}
          onIndex={(i) => setLb((p) => (p ? { ...p, index: i } : p))} onClose={() => setLb(null)}
        />
      </Show>
    </div>
  );
}
