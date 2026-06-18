import { createResource, createSignal, onCleanup, Show } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { muted } from "../prefs";

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Миниатюра. Базовые метаданные тянутся батчем (бейдж ▶/мм:сс/GIF). При наведении
 * на анимированный файл проигрывает превью: видео — со звуком (если не mute) и
 * перемоткой по горизонтали; гиф/apng — анимируется как <img>.
 */
export function Thumb(props: {
  api: HydrusApi;
  id: number;
  selected?: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  const [info] = createResource(
    () => props.id,
    (id) => props.api.basicMetadata(id).catch(() => null),
  );
  const [previewing, setPreviewing] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let vidEl: HTMLVideoElement | undefined;
  let wrapEl!: HTMLDivElement;

  const isVideo = () => (info()?.mime ?? "").startsWith("video");
  const animated = () => {
    const m = info();
    return !!m && (isVideo() || (m.num_frames ?? 0) > 1 || !!m.duration);
  };
  const badge = () => {
    const m = info();
    if (!m) return null;
    if (isVideo()) return m.duration ? fmtDur(m.duration) : "▶";
    if ((m.num_frames ?? 0) > 1 || m.duration) return "GIF";
    return null;
  };

  function enter() {
    if (!animated()) return;
    timer = setTimeout(() => setPreviewing(true), 200);
  }
  function stop() {
    if (vidEl) {
      vidEl.pause(); // удаление из DOM не гарантирует остановку звука
      vidEl = undefined;
    }
    setPreviewing(false);
  }
  function leave() {
    clearTimeout(timer);
    stop();
  }
  // scrub: позиция курсора по горизонтали → таймкод видео
  function move(e: MouseEvent) {
    if (!previewing() || !isVideo() || !vidEl || !vidEl.duration || !isFinite(vidEl.duration)) return;
    const rect = wrapEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    vidEl.currentTime = ratio * vidEl.duration;
  }

  onCleanup(() => {
    clearTimeout(timer);
    vidEl?.pause();
  });

  return (
    <div
      ref={wrapEl}
      class="thumb-wrap"
      classList={{ selected: props.selected }}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onMouseMove={move}
      onClick={(e) => props.onClick(e)}
    >
      <img class="thumb" src={props.api.thumbnailUrl(props.id)} loading="lazy" decoding="async" />
      <Show when={props.selected}>
        <span class="sel-check">✓</span>
      </Show>
      <Show when={badge() && !previewing()}>
        <span class="badge">{badge()}</span>
      </Show>
      <Show when={previewing()}>
        <Show
          when={isVideo()}
          fallback={<img class="thumb preview" src={props.api.fileUrl(props.id)} />}
        >
          <video
            ref={vidEl}
            class="thumb preview"
            src={props.api.fileUrl(props.id)}
            autoplay
            loop
            playsinline
            muted={muted()}
          />
        </Show>
      </Show>
    </div>
  );
}
