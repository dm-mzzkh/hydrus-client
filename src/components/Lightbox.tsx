import { createEffect, For, on, onCleanup, onMount, Show } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { createZoomPan } from "../zoom";
import { TagLabel } from "./TagLabel";
import { TagInput } from "./TagInput";

export interface LbMeta {
  name: string;
  tags: string[];
  urls: string[];
}

export type MediaKind = "image" | "video";
const VIDEO_RE = /\.(mp4|webm|mov|mkv|m4v|avi|ogv)(\?|#|$)/i;
/** тип медиа по url/имени файла (для urlʼов без расширения передавайте kinds явно) */
export const mediaKind = (urlOrName: string): MediaKind => (VIDEO_RE.test(urlOrName) ? "video" : "image");

interface Props {
  /** полноразмерные URL для просмотра (по порядку) */
  urls: string[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** опц. метаданные параллельно urls — показывает сайдбар как в галерее */
  metas?: LbMeta[];
  /** опц. тип каждого url (image/video) — если нет, определяется по расширению url */
  kinds?: MediaKind[];
  /** опц. редактирование тегов текущего медиа (нужен api для автокомплита) */
  api?: HydrusApi;
  onAddTag?: (index: number, tag: string) => void;
  onRemoveTag?: (index: number, tag: string) => void;
}

/**
 * Полноэкранный просмотр картинки с зумом/паном и навигацией — ровно как в галерее
 * (общий хук `createZoomPan` + те же css-классы). Работает с произвольными URL, поэтому
 * годится и для ещё не импортированных в Hydrus файлов. С `metas` показывает сайдбар
 * (теги + источники), чтобы видеть staged-файл так, как он будет выглядеть после импорта.
 */
export function Lightbox(props: Props) {
  const zp = createZoomPan();
  let overlayEl!: HTMLDivElement;
  const meta = () => props.metas?.[props.index];
  const kind = () => props.kinds?.[props.index] ?? mediaKind(props.urls[props.index]);

  const nav = (delta: number) => {
    const next = Math.min(props.urls.length - 1, Math.max(0, props.index + delta));
    if (next !== props.index) props.onIndex(next);
  };
  createEffect(on(() => props.index, () => zp.reset(), { defer: true }));

  function onKey(e: KeyboardEvent) {
    // не перехватываем навигацию/зум, пока печатают в поле (теги)
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    switch (e.code) {
      case "Escape":
      case "KeyQ": e.preventDefault(); props.onClose(); break;
      case "KeyA":
      case "ArrowLeft": e.preventDefault(); nav(-1); break;
      case "KeyD":
      case "ArrowRight": e.preventDefault(); nav(1); break;
      case "Equal":
      case "NumpadAdd": e.preventDefault(); zp.zoomAt(1.2); break;
      case "Minus":
      case "NumpadSubtract": e.preventDefault(); zp.zoomAt(1 / 1.2); break;
    }
  }
  onMount(() => {
    overlayEl.focus();
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const onOverlayClick = () => { if (zp.justDragged()) return; props.onClose(); };

  return (
    <div ref={overlayEl} class="overlay" tabindex={-1} onClick={onOverlayClick}>
      <div class="viewer">
        <div class="toolbar" onClick={(e) => e.stopPropagation()}>
          <span class="counter">{props.index + 1} / {props.urls.length}</span>
          <Show when={meta()?.name}><span class="muted lb-title">{meta()!.name}</span></Show>
          <span class="spacer" />
          <button title="Reset zoom (double-click)" onClick={() => zp.reset()}>1:1 ⟲</button>
          <button class="close" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        <div class="viewer-body">
          {/* фон медиа-области кликом закрывает (как в галерее); сам <img>/<video> — нет.
              для видео не превентим mousedown, чтобы работали контролы */}
          <div ref={zp.mediaRef} class="media grab" onMouseDown={(e) => zp.onDown(e, kind() !== "video")} onWheel={zp.onWheel} onDblClick={() => zp.reset()}>
            <div ref={zp.innerRef} class="media-inner" style={{ transform: zp.transform() }}>
              <Show
                when={kind() === "video"}
                fallback={<img src={props.urls[props.index]} draggable={false} onClick={(e) => e.stopPropagation()} />}
              >
                <video src={props.urls[props.index]} controls autoplay loop onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} />
              </Show>
            </div>
          </div>
          <Show when={meta()}>
            <aside class="sidebar lb-sidebar" onClick={(e) => e.stopPropagation()}>
              <div class="tag-group">
                <div class="group-name">tags <span class="group-count">{meta()!.tags.length}</span></div>
                <div class="taglist">
                  <For each={[...meta()!.tags].sort()} fallback={<span class="muted">no tags</span>}>
                    {(t) => (
                      <div class="tag">
                        <span class="tag-text"><TagLabel value={t} /></span>
                        <Show when={props.onRemoveTag}>
                          <button class="tag-x" title="Remove tag" onClick={() => props.onRemoveTag!(props.index, t)}>×</button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <Show when={props.onAddTag && props.api}>
                  <TagInput api={props.api!} placeholder="add tag…" onPick={(t) => props.onAddTag!(props.index, t)} />
                </Show>
              </div>
              <Show when={meta()!.urls.length}>
                <div class="tag-group">
                  <div class="group-name">urls</div>
                  <For each={meta()!.urls}>
                    {(u) => <a class="known-url" href={u} target="_blank" rel="noreferrer">{u}</a>}
                  </For>
                </div>
              </Show>
            </aside>
          </Show>
        </div>
        <Show when={props.urls.length > 1}>
          <button class="lb-nav prev" onClick={(e) => { e.stopPropagation(); nav(-1); }} aria-label="Previous">‹</button>
          <button class="lb-nav next" onClick={(e) => { e.stopPropagation(); nav(1); }} aria-label="Next">›</button>
        </Show>
      </div>
    </div>
  );
}
