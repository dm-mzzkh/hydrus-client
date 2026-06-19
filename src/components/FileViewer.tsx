import {
  createEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { HydrusApi, isFlashMime, type FileMetadata, type ServiceInfo } from "../api/hydrus";
import { muted } from "../prefs";
import { pushToast } from "../toast";
import { TagInput } from "./TagInput";
import { TagLabel } from "./TagLabel";

// Ruffle — эмулятор Flash на WASM. Браузеры SWF не играют, поэтому грузим Ruffle
// лениво с CDN (один раз на страницу) и только когда реально открыли .swf.
const RUFFLE_CDN = "https://unpkg.com/@ruffle-rs/ruffle";
let rufflePromise: Promise<any> | undefined;
function loadRuffle(): Promise<any> {
  if (rufflePromise) return rufflePromise;
  rufflePromise = new Promise<any>((resolve, reject) => {
    const w = window as any;
    if (w.RufflePlayer?.newest) return resolve(w.RufflePlayer.newest());
    const s = document.createElement("script");
    s.src = RUFFLE_CDN;
    s.async = true;
    s.onload = () => {
      const r = w.RufflePlayer?.newest?.();
      r ? resolve(r) : reject(new Error("Ruffle загрузился, но RufflePlayer недоступен"));
    };
    s.onerror = () => reject(new Error("не удалось загрузить Ruffle с CDN"));
    document.head.appendChild(s);
  });
  rufflePromise.catch(() => (rufflePromise = undefined)); // дать повторить попытку
  return rufflePromise;
}

interface Props {
  api: HydrusApi;
  fileIds: number[];
  index: number;
  onIndex: (i: number) => void;
  /** число колонок грида — шаг для W/S */
  columns: number;
  /** локальный тег-сервис по умолчанию (куда добавлять теги) */
  tagService?: string;
  onSearchTag: (tag: string) => void;
  onClose: () => void;
}

export function FileViewer(props: Props) {
  const fileId = () => props.fileIds[props.index];
  const [meta, { mutate, refetch }] = createResource(fileId, (id) => props.api.fileMetadata(id));
  const resync = () => refetch();
  // оптимистично правим локальные метаданные (без полного refetch — не дёргает UI)
  const applyLocal = (fn: (m: FileMetadata) => FileMetadata) => mutate((m) => (m ? fn(m) : m));
  const ready = () => (meta.state === "ready" ? meta() : undefined);
  const isVid = () => (ready()?.mime ?? "").startsWith("video");
  const isFlash = () => isFlashMime(ready()?.mime);
  // интерактивные типы (видео-контролы, Flash-игры) — мышь отдаём им, не паним
  const isInteractive = () => isVid() || isFlash();

  // зум / пан / режим масштаба
  const [scale, setScale] = createSignal(1);
  const [tx, setTx] = createSignal(0);
  const [ty, setTy] = createSignal(0);
  const [actual, setActual] = createSignal(false); // false = fit, true = 1:1
  let overlayEl!: HTMLDivElement;
  let mediaEl: HTMLDivElement | undefined;
  let innerEl: HTMLDivElement | undefined;
  let dragging = false;
  let moved = false;
  let lastDragEndAt = 0;
  let sx = 0;
  let sy = 0;
  let ox = 0;
  let oy = 0;

  const reset = () => {
    setScale(1);
    setTx(0);
    setTy(0);
  };
  createEffect(on(fileId, () => { reset(); setActual(false); }, { defer: true }));

  // клампинг пана: не даём увести масштабированный контент дальше края вьюпорта.
  // граница = (размер контента·scale − вьюпорт)/2; offsetWidth дочернего <img>/<video>
  // не зависит от CSS-трансформа, поэтому стабилен и не требует, чтобы стиль успел примениться.
  function clamp() {
    if (!mediaEl) return;
    const child = innerEl?.firstElementChild as HTMLElement | null;
    const cw = mediaEl.clientWidth;
    const ch = mediaEl.clientHeight;
    const s = scale();
    const iw = (child?.offsetWidth ?? cw) * s;
    const ih = (child?.offsetHeight ?? ch) * s;
    const bx = Math.max(0, (iw - cw) / 2);
    const by = Math.max(0, (ih - ch) / 2);
    setTx((x) => Math.max(-bx, Math.min(bx, x)));
    setTy((y) => Math.max(-by, Math.min(by, y)));
  }

  // префетч соседей (±1 и ±ряд)
  createEffect(
    on(
      () => props.index,
      (i) => {
        const cols = Math.max(1, props.columns);
        for (const j of [i + 1, i - 1, i + cols, i - cols]) {
          const id = props.fileIds[j];
          if (id === undefined) continue;
          props.api
            .fileMetadata(id)
            .then((m) => {
              if ((m.mime ?? "").startsWith("image")) {
                const im = new Image();
                im.src = props.api.fileUrl(id);
              }
            })
            .catch(() => {});
        }
      },
    ),
  );

  function zoomAt(factor: number, cx = 0, cy = 0) {
    const s = scale();
    const s2 = Math.min(10, Math.max(0.15, s * factor));
    if (s2 === s) return;
    const r = s2 / s;
    setTx(cx - r * (cx - tx()));
    setTy(cy - r * (cy - ty()));
    setScale(s2);
    clamp();
  }

  const nav = (delta: number) => {
    const next = Math.min(props.fileIds.length - 1, Math.max(0, props.index + delta));
    if (next !== props.index) props.onIndex(next);
  };

  async function fileAction(
    label: string,
    apply: (ids: number[]) => Promise<void>,
    undo: (ids: number[]) => Promise<void>,
    advance: boolean,
  ) {
    const cur = fileId();
    if (cur == null) return;
    const ids = [cur];
    if (advance) nav(1); // переходим сразу, запрос летит в фоне
    try {
      await apply(ids);
      pushToast(label, {
        onUndo: () => void undo(ids).catch((e) => pushToast(String(e), { kind: "error" })),
      });
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }
  const archiveCurrent = () =>
    fileAction("Archived", (ids) => props.api.archiveFiles(ids), (ids) => props.api.unarchiveFiles(ids), true);
  const inboxCurrent = () =>
    fileAction("Moved to inbox", (ids) => props.api.unarchiveFiles(ids), (ids) => props.api.archiveFiles(ids), false);
  const trashCurrent = () =>
    fileAction("Sent to trash", (ids) => props.api.deleteFiles(ids), (ids) => props.api.undeleteFiles(ids), true);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else mediaEl?.requestFullscreen?.();
  }

  async function download(m: FileMetadata) {
    try {
      const r = await fetch(props.api.fileUrl(m.file_id));
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `${m.hash}${m.ext ?? ""}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      pushToast(`Download failed: ${String(e)}`, { kind: "error" });
    }
  }

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      pushToast("Hash copied");
    } catch {
      pushToast("Copy failed", { kind: "error" });
    }
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    if (e.key === "Escape") {
      e.preventDefault();
      // во время ввода тега Escape снимает фокус (и закрывает автокомплит), а не вьюер
      if (typing) t?.blur();
      else props.onClose();
      return;
    }
    if (typing) return;
    // Shift+D — в корзину (перехватываем до switch, чтобы обычная D осталась навигацией)
    if (e.shiftKey && e.code === "KeyD") {
      e.preventDefault();
      void trashCurrent();
      return;
    }
    const rows = Math.max(1, props.columns);
    switch (e.code) {
      case "KeyQ": e.preventDefault(); props.onClose(); break;
      case "KeyA": e.preventDefault(); nav(-1); break;
      case "KeyD": e.preventDefault(); nav(1); break;
      case "KeyW": e.preventDefault(); nav(-rows); break;
      case "KeyS": e.preventDefault(); nav(rows); break;
      case "KeyF": e.preventDefault(); void archiveCurrent(); break;
      case "Delete":
      case "Backspace": e.preventDefault(); void trashCurrent(); break;
      case "Equal":
      case "NumpadAdd": e.preventDefault(); zoomAt(1.2); break;
      case "Minus":
      case "NumpadSubtract": e.preventDefault(); zoomAt(1 / 1.2); break;
    }
  }

  function onMove(e: MouseEvent) {
    if (!dragging) return;
    moved = true;
    setTx(ox + (e.clientX - sx));
    setTy(oy + (e.clientY - sy));
    clamp();
  }
  function onUp() {
    if (moved) lastDragEndAt = performance.now();
    dragging = false;
  }

  onMount(() => {
    overlayEl.focus();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    });
  });

  function onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    sx = e.clientX;
    sy = e.clientY;
    ox = tx();
    oy = ty();
    if (!isInteractive()) e.preventDefault();
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // нормализуем дельту к пикселям, затем экспоненциальный шаг — плавно на тачпаде
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; // строки
    else if (e.deltaMode === 2) dy *= rect.height; // страницы
    const factor = Math.exp(-dy * 0.0018);
    zoomAt(
      factor,
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2),
    );
  }
  function onOverlayClick() {
    if (performance.now() - lastDragEndAt < 250) return;
    props.onClose();
  }

  return (
    <div ref={overlayEl} class="overlay" tabindex={-1} onClick={onOverlayClick}>
      <div class="viewer" onClick={(e) => e.stopPropagation()}>
        <div class="toolbar">
          <span class="counter">{props.index + 1} / {props.fileIds.length}</span>
          <span class="spacer" />
          <button title="Archive (F)" onClick={() => void archiveCurrent()}>🗄</button>
          <button title="Back to inbox" onClick={() => void inboxCurrent()}>📥</button>
          <button title="Trash (Del / Shift+D)" onClick={() => void trashCurrent()}>🗑</button>
          <button title="Fit / 1:1" onClick={() => { setActual((a) => !a); reset(); }}>
            {actual() ? "Fit" : "1:1"}
          </button>
          <button title="Fullscreen" onClick={toggleFullscreen}>⛶</button>
          <Show when={ready()}>
            {(m) => (
              <>
                <button title="Copy hash" onClick={() => void copyHash(m().hash)}>⧉</button>
                <button title="Download" onClick={() => void download(m())}>⬇</button>
              </>
            )}
          </Show>
          <button class="close" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        <ErrorBoundary fallback={(err) => <p class="error">Render error: {String(err)}</p>}>
          <Switch fallback={<p class="loading">Loading…</p>}>
            <Match when={meta.error}>
              <p class="error">Failed to load: {String(meta.error)}</p>
            </Match>
            <Match when={meta()}>
              {(m) => (
                <div class="viewer-body">
                  <div ref={mediaEl} class="media grab" onMouseDown={onDown} onWheel={onWheel} onDblClick={reset}>
                    <div
                      ref={innerEl}
                      classList={{ "media-inner": true, actual: actual() }}
                      style={{ transform: `translate(${tx()}px, ${ty()}px) scale(${scale()})` }}
                    >
                      <Switch fallback={<ImageView api={props.api} meta={m()} />}>
                        <Match when={(m().mime ?? "").startsWith("video")}>
                          <video src={props.api.fileUrl(m().file_id)} controls autoplay loop />
                        </Match>
                        <Match when={isFlashMime(m().mime)}>
                          <FlashView api={props.api} meta={m()} />
                        </Match>
                      </Switch>
                    </div>
                  </div>
                  <Sidebar
                    api={props.api}
                    meta={m()}
                    tagService={props.tagService}
                    onSearchTag={props.onSearchTag}
                    mutate={applyLocal}
                    resync={resync}
                  />
                </div>
              )}
            </Match>
          </Switch>
        </ErrorBoundary>
      </div>
    </div>
  );
}

interface TagGroup {
  key: string;
  name: string;
  type: number;
  tags: string[];
}

function buildTagGroups(meta: FileMetadata): TagGroup[] {
  const groups: TagGroup[] = [];
  for (const [key, svc] of Object.entries(meta.tags ?? {})) {
    const tags = svc.display_tags?.["0"] ?? [];
    if (tags.length) {
      groups.push({ key, name: svc.name ?? key, type: svc.type, tags: [...tags].sort() });
    }
  }
  const rank = (t: number) => (t === 5 ? 0 : t === 0 ? 1 : 2);
  groups.sort((a, b) => rank(a.type) - rank(b.type) || (a.name ?? "").localeCompare(b.name ?? ""));
  return groups;
}

/** Картинка с прогрессивной загрузкой: миниатюра (с блюром) → полноразмер по onload. */
function ImageView(props: { api: HydrusApi; meta: FileMetadata }) {
  const [src, setSrc] = createSignal(props.api.thumbnailUrl(props.meta.file_id));
  const [loaded, setLoaded] = createSignal(false);
  createEffect(
    on(
      () => props.meta.file_id,
      (id) => {
        setLoaded(false);
        setSrc(props.api.thumbnailUrl(id));
        const pre = new Image();
        pre.onload = () => {
          if (props.meta.file_id === id) {
            setSrc(props.api.fileUrl(id));
            setLoaded(true);
          }
        };
        pre.src = props.api.fileUrl(id);
        onCleanup(() => {
          pre.onload = null;
        });
      },
    ),
  );
  return <img classList={{ blur: !loaded() }} src={src()} alt={props.meta.hash} draggable={false} />;
}

/** Воспроизведение SWF: создаём Ruffle-плеер и скармливаем ему fileUrl (ключ уже в query). */
function FlashView(props: { api: HydrusApi; meta: FileMetadata }) {
  let host!: HTMLDivElement;
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(true);

  createEffect(
    on(
      () => props.meta.file_id,
      (id) => {
        setError(undefined);
        setLoading(true);
        let player: any;
        let cancelled = false;
        loadRuffle()
          .then((ruffle) => {
            if (cancelled) return;
            host.replaceChildren(); // на случай повторного запуска (навигация между .swf)
            player = ruffle.createPlayer();
            player.style.width = "100%";
            player.style.height = "100%";
            host.appendChild(player);
            return player.load({ url: props.api.fileUrl(id), autoplay: "on", volume: muted() ? 0 : 1 });
          })
          .then(() => !cancelled && setLoading(false))
          .catch((e) => !cancelled && setError(String(e)));
        onCleanup(() => {
          cancelled = true;
          try {
            player?.remove(); // Ruffle уничтожает инстанс при отсоединении от DOM
          } catch {}
        });
      },
    ),
  );

  return (
    <Show when={!error()} fallback={<p class="error">Flash failed: {error()}</p>}>
      <div class="flash-wrap">
        <div ref={host} class="flash-host" />
        <Show when={loading()}>
          <span class="loading flash-loading">Loading Flash…</span>
        </Show>
      </div>
    </Show>
  );
}

// --- оптимистичные правки метаданных (для мгновенного UI без refetch) ---
function withTagRemoved(m: FileMetadata, svc: string, tag: string): FileMetadata {
  const c = structuredClone(m);
  const s = c.tags?.[svc];
  if (s?.display_tags?.["0"]) s.display_tags["0"] = s.display_tags["0"].filter((x) => x !== tag);
  if (s?.storage_tags?.["0"]) s.storage_tags["0"] = s.storage_tags["0"].filter((x) => x !== tag);
  return c;
}
function withTagAdded(m: FileMetadata, svc: string, name: string, tag: string): FileMetadata {
  const c = structuredClone(m);
  if (!c.tags) c.tags = {};
  const s = c.tags[svc] ?? (c.tags[svc] = { name, type: 5, display_tags: {}, storage_tags: {} });
  for (const field of ["display_tags", "storage_tags"] as const) {
    const obj = s[field] ?? (s[field] = {});
    const arr = obj["0"] ?? (obj["0"] = []);
    if (!arr.includes(tag)) arr.push(tag);
  }
  return c;
}
function withRating(
  m: FileMetadata,
  svc: string,
  name: string,
  type: number,
  value: boolean | number | null,
): FileMetadata {
  const c = structuredClone(m);
  if (!c.ratings) c.ratings = {};
  const prev = c.ratings[svc];
  c.ratings[svc] = { name: prev?.name ?? name, type: prev?.type ?? type, rating: value };
  return c;
}
function withNote(m: FileMetadata, name: string, text: string): FileMetadata {
  const c = structuredClone(m);
  if (!c.notes) c.notes = {};
  c.notes[name] = text;
  return c;
}
function withNoteRemoved(m: FileMetadata, name: string): FileMetadata {
  const c = structuredClone(m);
  if (c.notes) delete c.notes[name];
  return c;
}

interface SidebarProps {
  api: HydrusApi;
  meta: FileMetadata;
  tagService?: string;
  onSearchTag: (tag: string) => void;
  mutate: (fn: (m: FileMetadata) => FileMetadata) => void;
  resync: () => void;
}

function Sidebar(props: SidebarProps) {
  const [services] = createResource<Record<string, ServiceInfo>>(async () => {
    try {
      return await props.api.services();
    } catch {
      return {};
    }
  });
  const groups = () => buildTagGroups(props.meta);
  const [xDown, setXDown] = createSignal(false); // зажат X → режим удаления
  const [zDown, setZDown] = createSignal(false); // зажат Z → выделение
  const [selected, setSelected] = createSignal<Set<string>>(new Set()); // выбранные теги (serviceKey\x01tag)

  const tagKey = (serviceKey: string, tag: string) => `${serviceKey}\x01${tag}`;
  const id = () => props.meta.file_id;
  let anchor: { svc: string; tag: string } | null = null; // якорь для Shift-диапазона

  // X = удаление, Z = выделение (зажатые буквы; на любой раскладке по e.code)
  onMount(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    const kd = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      if (e.code === "KeyX") setXDown(true);
      else if (e.code === "KeyZ") setZDown(true);
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "KeyX") setXDown(false);
      else if (e.code === "KeyZ") setZDown(false);
    };
    const reset = () => {
      setXDown(false);
      setZDown(false);
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", reset);
    onCleanup(() => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", reset);
    });
  });

  // сброс выделения при смене файла
  createEffect(on(id, () => {
    setSelected(new Set<string>());
    anchor = null;
  }, { defer: true }));

  // запрос в фоне; при ошибке возвращаем правду с сервера + сообщаем
  const fire = (p: Promise<void>) =>
    p.catch(() => {
      props.resync();
      pushToast("Action failed", { kind: "error" });
    });

  function addTagValue(tag: string) {
    const key = props.tagService;
    if (!tag || !key) return;
    const name = services()?.[key]?.name ?? key;
    props.mutate((m) => withTagAdded(m, key, name, tag));
    void fire(props.api.addTags([id()], key, [tag]));
  }
  function removeTag(tag: string, svc: string) {
    props.mutate((m) => withTagRemoved(m, svc, tag));
    void fire(props.api.addTags([id()], svc, [], [tag]));
  }
  function deleteSelected() {
    const byService = new Map<string, string[]>();
    for (const key of selected()) {
      const sep = key.indexOf("\x01");
      const svc = key.slice(0, sep);
      const tag = key.slice(sep + 1);
      (byService.get(svc) ?? byService.set(svc, []).get(svc)!).push(tag);
    }
    setSelected(new Set<string>());
    props.mutate((m) => {
      let c = m;
      for (const [svc, tags] of byService) for (const tag of tags) c = withTagRemoved(c, svc, tag);
      return c;
    });
    for (const [svc, tags] of byService) void fire(props.api.addTags([id()], svc, [], tags));
  }
  function setRating(svc: string, name: string, type: number, value: boolean | number | null) {
    props.mutate((m) => withRating(m, svc, name, type, value));
    void fire(props.api.setRating([id()], svc, value));
  }
  function setNote(name: string, text: string) {
    const nm = name.trim();
    if (!nm) return;
    props.mutate((m) => withNote(m, nm, text));
    void fire(props.api.setNotes([id()], { [nm]: text }));
  }
  function deleteNote(name: string) {
    props.mutate((m) => withNoteRemoved(m, name));
    void fire(props.api.deleteNotes([id()], [name]));
  }
  function toggleSelect(key: string) {
    const next = new Set(selected());
    next.has(key) ? next.delete(key) : next.add(key);
    setSelected(next);
  }

  function onTagClick(e: MouseEvent, tag: string, g: TagGroup) {
    const key = tagKey(g.key, tag);
    if (xDown() && g.type === 5) {
      if (selected().has(key) && selected().size) deleteSelected();
      else removeTag(tag, g.key);
      return;
    }
    if (e.shiftKey && g.type === 5) {
      // диапазон от якоря до клика в пределах одной группы
      const tags = g.tags;
      const to = tags.indexOf(tag);
      const a = anchor && anchor.svc === g.key ? tags.indexOf(anchor.tag) : -1;
      const from = a >= 0 ? a : to;
      const next = new Set(selected());
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(tagKey(g.key, tags[i]));
      setSelected(next);
      if (a < 0) anchor = { svc: g.key, tag };
      return;
    }
    if (zDown() && g.type === 5) {
      toggleSelect(key);
      anchor = { svc: g.key, tag };
      return;
    }
    props.onSearchTag(tag);
  }

  return (
    <aside class="sidebar">
      <div class="info">
        {props.meta.width}×{props.meta.height} · {props.meta.mime} ·{" "}
        {(props.meta.size / 1024 / 1024).toFixed(2)} MB
      </div>

      <Ratings meta={props.meta} services={services()} onSet={setRating} />

      <Show when={props.tagService}>
        <TagInput api={props.api} placeholder="add tag…" onPick={addTagValue} />
      </Show>

      <For each={groups()} fallback={<span class="muted">no tags</span>}>
        {(g) => (
          <div class="tag-group">
            <div class="group-name">
              {g.name} <span class="group-count">{g.tags.length}</span>
            </div>
            <div class="taglist">
              <For each={g.tags}>
                {(t) => {
                  const isSel = () => selected().has(tagKey(g.key, t));
                  const del = () => xDown() && g.type === 5;
                  return (
                    <div class="tag">
                      <span
                        class="tag-text"
                        classList={{ tagsel: isSel(), del: del() }}
                        title={del() ? "Click to remove" : "Z/Shift-click to select · click to search"}
                        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                        onClick={(e) => onTagClick(e, t, g)}
                      >
                        <TagLabel value={t} />
                      </span>
                      <Show when={g.type === 5}>
                        <button class="tag-x" title="Remove" onClick={() => void removeTag(t, g.key)}>
                          ×
                        </button>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        )}
      </For>

      <Show when={props.meta.known_urls?.length}>
        <div class="tag-group">
          <div class="group-name">urls</div>
          <For each={props.meta.known_urls}>
            {(u) => (
              <a class="known-url" href={u} target="_blank" rel="noreferrer">
                {u}
              </a>
            )}
          </For>
        </div>
      </Show>

      <Notes meta={props.meta} onSet={setNote} onDelete={deleteNote} />
    </aside>
  );
}

function Ratings(props: {
  meta: FileMetadata;
  services?: Record<string, ServiceInfo>;
  onSet: (svc: string, name: string, type: number, value: boolean | number | null) => void;
}) {
  const list = () =>
    Object.values(props.services ?? {}).filter((s) => s.type === 6 || s.type === 7 || s.type === 22);

  return (
    <Show when={list().length}>
      <div class="ratings">
        <For each={list()}>
          {(s) => {
            const cur = () => props.meta.ratings?.[s.service_key]?.rating ?? null;
            const set = (value: boolean | number | null) => props.onSet(s.service_key, s.name, s.type, value);
            return (
              <div class="rating">
                <span class="rating-name">{s.name}</span>
                <span class="rating-ctl">
                  <Switch>
                    <Match when={s.type === 7}>
                      <button classList={{ on: cur() === true }} onClick={() => set(cur() === true ? null : true)}>♥</button>
                      <button classList={{ on: cur() === false }} onClick={() => set(cur() === false ? null : false)}>✗</button>
                    </Match>
                    <Match when={s.type === 6}>
                      <For each={Array.from({ length: s.max_stars ?? 5 }, (_, i) => i + 1)}>
                        {(i) => (
                          <button
                            class="star"
                            classList={{ on: Number(cur() ?? 0) >= i }}
                            onClick={() => set(cur() === i ? null : i)}
                          >
                            ★
                          </button>
                        )}
                      </For>
                    </Match>
                    <Match when={s.type === 22}>
                      <button onClick={() => set(Math.max(0, Number(cur() ?? 0) - 1))}>−</button>
                      <span class="incdec">{Number(cur() ?? 0)}</span>
                      <button onClick={() => set(Number(cur() ?? 0) + 1)}>+</button>
                    </Match>
                  </Switch>
                </span>
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

/**
 * Просмотр и редактирование заметок файла (notes из include_notes). Заметки показываются
 * read-only; «✎» открывает редактор (имя+текст) — одновременно правится одна. Переименование
 * = удалить старую + поставить новую. Сохранение/удаление оптимистичны (см. Sidebar).
 */
function Notes(props: {
  meta: FileMetadata;
  onSet: (name: string, text: string) => void;
  onDelete: (name: string) => void;
}) {
  const entries = () => Object.entries(props.meta.notes ?? {});
  const [editing, setEditing] = createSignal<string | null>(null); // имя редактируемой заметки
  const [adding, setAdding] = createSignal(false);
  const [draftName, setDraftName] = createSignal("");
  const [draft, setDraft] = createSignal("");

  // сброс редактора при смене файла
  createEffect(on(() => props.meta.file_id, () => { setEditing(null); setAdding(false); }, { defer: true }));

  function startEdit(name: string, text: string) {
    setAdding(false);
    setEditing(name);
    setDraftName(name);
    setDraft(text);
  }
  function startNew() {
    setEditing(null);
    setAdding(true);
    setDraftName("");
    setDraft("");
  }
  function cancel() {
    setEditing(null);
    setAdding(false);
  }
  function save() {
    const nm = draftName().trim();
    if (!nm || !draft().trim()) return;
    const orig = editing();
    if (orig && orig !== nm) props.onDelete(orig); // переименование
    props.onSet(nm, draft());
    cancel();
  }
  // Escape отменяет, Ctrl/⌘+Enter сохраняет; stop, чтобы вьюер не словил Escape/букву как навигацию
  function onEditorKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.stopPropagation();
      save();
    }
  }

  const editor = (isNew: boolean) => (
    <div class="note note-edit" onKeyDown={onEditorKey}>
      <input
        class="note-name-input"
        placeholder="name"
        autofocus
        value={draftName()}
        onInput={(e) => setDraftName(e.currentTarget.value)}
      />
      <textarea
        class="note-text-edit"
        rows={4}
        placeholder="text"
        value={draft()}
        onInput={(e) => setDraft(e.currentTarget.value)}
      />
      <div class="note-edit-actions">
        <button onClick={cancel}>Cancel</button>
        <button onClick={save}>{isNew ? "Add" : "Save"}</button>
      </div>
    </div>
  );

  return (
    <div class="tag-group notes-group">
      <div class="group-name">
        notes <span class="group-count">{entries().length}</span>
        <button class="note-add-btn" title="Add note" onClick={startNew}>＋</button>
      </div>
      <Show when={adding()}>{editor(true)}</Show>
      <For each={entries()}>
        {([name, text]) => (
          <Show when={editing() === name} fallback={
            <div class="note">
              <div class="note-head">
                <span class="note-title">{name}</span>
                <span class="note-actions">
                  <button class="note-edit-btn" title="Edit" onClick={() => startEdit(name, text)}>✎</button>
                  <button class="tag-x" title="Delete" onClick={() => props.onDelete(name)}>×</button>
                </span>
              </div>
              <div class="note-body">{text}</div>
            </div>
          }>
            {editor(false)}
          </Show>
        )}
      </For>
    </div>
  );
}
