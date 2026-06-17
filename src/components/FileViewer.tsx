import { createResource, For, Show } from "solid-js";
import { collectTags, HydrusApi, type FileMetadata } from "../api/hydrus";

export function FileViewer(props: { api: HydrusApi; fileId: number; onClose: () => void }) {
  const [meta] = createResource(
    () => props.fileId,
    (id) => props.api.fileMetadata(id),
  );

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="viewer" onClick={(e) => e.stopPropagation()}>
        <button class="close" onClick={props.onClose} aria-label="Закрыть">
          ✕
        </button>
        <Show when={meta()} fallback={<p class="loading">Загрузка…</p>}>
          {(m) => <ViewerBody api={props.api} meta={m()} />}
        </Show>
      </div>
    </div>
  );
}

function ViewerBody(props: { api: HydrusApi; meta: FileMetadata }) {
  const url = props.api.fileUrl(props.meta.file_id);
  const tags = collectTags(props.meta);
  const isVideo = props.meta.mime.startsWith("video");

  return (
    <div class="viewer-body">
      <div class="media">
        <Show
          when={isVideo}
          fallback={<img src={url} alt={props.meta.hash} />}
        >
          <video src={url} controls autoplay loop />
        </Show>
      </div>
      <aside class="sidebar">
        <div class="info">
          {props.meta.width}×{props.meta.height} · {props.meta.mime} ·{" "}
          {(props.meta.size / 1024 / 1024).toFixed(2)} MB
        </div>
        <div class="taglist">
          <For each={tags} fallback={<span class="muted">нет тегов</span>}>
            {(t) => <div class="tag">{t}</div>}
          </For>
        </div>
      </aside>
    </div>
  );
}
