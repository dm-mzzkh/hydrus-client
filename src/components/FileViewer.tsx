import { createResource, ErrorBoundary, For, Match, Show, Switch } from "solid-js";
import { HydrusApi, type FileMetadata, type RatingEntry } from "../api/hydrus";
import { TagLabel } from "./TagLabel";

export function FileViewer(props: { api: HydrusApi; fileId: number; onClose: () => void }) {
  const [meta] = createResource(
    () => props.fileId,
    (id) => props.api.fileMetadata(id),
  );

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="viewer" onClick={(e) => e.stopPropagation()}>
        <button class="close" onClick={props.onClose} aria-label="Close">
          ✕
        </button>
        <ErrorBoundary fallback={(err) => <p class="error">Render error: {String(err)}</p>}>
          <Switch fallback={<p class="loading">Loading…</p>}>
            <Match when={meta.error}>
              <p class="error">Failed to load: {String(meta.error)}</p>
            </Match>
            <Match when={meta()}>{(m) => <ViewerBody api={props.api} meta={m()} />}</Match>
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

/** Tag groups by tag service (domain), current display tags. */
function buildTagGroups(meta: FileMetadata): TagGroup[] {
  const groups: TagGroup[] = [];
  for (const [key, svc] of Object.entries(meta.tags ?? {})) {
    const tags = svc.display_tags?.["0"] ?? [];
    if (tags.length) {
      groups.push({ key, name: svc.name ?? key, type: svc.type, tags: [...tags].sort() });
    }
  }
  // local domains (5) → repositories (0) → others; by name within
  const rank = (t: number) => (t === 5 ? 0 : t === 0 ? 1 : 2);
  groups.sort((a, b) => rank(a.type) - rank(b.type) || (a.name ?? "").localeCompare(b.name ?? ""));
  return groups;
}

function buildRatings(meta: FileMetadata): Array<{ key: string } & RatingEntry> {
  return Object.entries(meta.ratings ?? {})
    .filter(([, r]) => r && r.rating !== null && r.rating !== undefined)
    .map(([key, r]) => ({ key, ...r }));
}

function ViewerBody(props: { api: HydrusApi; meta: FileMetadata }) {
  const url = props.api.fileUrl(props.meta.file_id);
  const isVideo = (props.meta.mime ?? "").startsWith("video");
  const [services] = createResource(async () => {
    try {
      return await props.api.services();
    } catch {
      return {};
    }
  });

  const groups = () => buildTagGroups(props.meta);
  const ratings = () => buildRatings(props.meta);

  return (
    <div class="viewer-body">
      <div class="media">
        <Show when={isVideo} fallback={<img src={url} alt={props.meta.hash} />}>
          <video src={url} controls autoplay loop />
        </Show>
      </div>
      <aside class="sidebar">
        <div class="info">
          {props.meta.width}×{props.meta.height} · {props.meta.mime} ·{" "}
          {(props.meta.size / 1024 / 1024).toFixed(2)} MB
        </div>

        <Show when={ratings().length}>
          <div class="ratings">
            <For each={ratings()}>
              {(r) => (
                <div class="rating">
                  <span class="rating-name">{r.name}</span>
                  <span class="rating-val">
                    {formatRating(r, services()?.[r.key]?.max_stars)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <For each={groups()} fallback={<span class="muted">no tags</span>}>
          {(g) => (
            <div class="tag-group">
              <div class="group-name">
                {g.name} <span class="group-count">{g.tags.length}</span>
              </div>
              <div class="taglist">
                <For each={g.tags}>
                  {(t) => (
                    <div class="tag">
                      <TagLabel value={t} />
                    </div>
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </aside>
    </div>
  );
}

function formatRating(r: RatingEntry, maxStars?: number): string {
  switch (r.type) {
    case 7: // like/dislike
      return r.rating ? "♥ like" : "✗ dislike";
    case 6: {
      // numerical
      const n = Math.max(0, Math.round(Number(r.rating)) || 0);
      if (maxStars && maxStars > 0 && maxStars <= 20) {
        const filled = Math.min(n, maxStars);
        return "★".repeat(filled) + "☆".repeat(maxStars - filled);
      }
      return maxStars ? `★ ${n}/${maxStars}` : `★ ${n}`;
    }
    case 22: // inc/dec
      return `↕ ${r.rating}`;
    default:
      return String(r.rating);
  }
}
