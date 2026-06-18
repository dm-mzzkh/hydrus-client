import type { FileMetadata } from "./api/hydrus";

/**
 * Предпочтение форматов: lossless/исходник выше перекодированного lossy.
 * Используется только как глубокий тай-брейк. Настраиваемо.
 */
const FORMAT_RANK: Record<string, number> = {
  "image/png": 3,
  "image/apng": 3,
  "image/tiff": 3,
  "image/webp": 2,
  "image/jpeg": 1,
  "image/gif": 1,
  "video/webm": 2,
  "video/mp4": 2,
  "video/x-matroska": 2,
  "video/quicktime": 1,
  "video/x-msvideo": 1,
};

export const pixels = (m: FileMetadata): number => (m.width ?? 0) * (m.height ?? 0);
export const formatRank = (m: FileMetadata): number => FORMAT_RANK[m.mime] ?? 0;
const importedAt = (m: FileMetadata): number => m.time_imported ?? Number.POSITIVE_INFINITY;
const frames = (m: FileMetadata): number => m.num_frames ?? 0;
const duration = (m: FileMetadata): number => m.duration ?? 0;
const hasAudio = (m: FileMetadata): boolean => m.has_audio === true;
const isVideo = (m: FileMetadata): boolean => (m.mime ?? "").startsWith("video");

/** Видео или анимированная картинка (gif/apng/animated webp) — «движущийся» файл. */
export const isMotion = (m: FileMetadata): boolean =>
  isVideo(m) || (m.num_frames ?? 0) > 1 || (m.duration ?? 0) > 0;

export const dims = (m: FileMetadata): string => `${m.width ?? "?"}×${m.height ?? "?"}`;
export const ext = (m: FileMetadata): string => (m.ext ?? "").replace(/^\./, "") || m.mime;
export const fmtSize = (n: number): string =>
  n >= 1 << 20 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
export const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Краткая строка метаданных для UI (картинки — dims/size/ext; видео/анимации — +длительность/кадры/звук). */
export function mediaInfo(m: FileMetadata): string {
  const parts = [dims(m)];
  if (isMotion(m)) {
    if (duration(m) > 0) parts.push(fmtDur(duration(m)));
    if (frames(m) > 1) parts.push(`${frames(m)}f`);
    if (isVideo(m)) parts.push(hasAudio(m) ? "🔊" : "🔇");
  }
  parts.push(fmtSize(m.size), ext(m));
  return parts.join(" · ");
}

export interface Decision {
  /** выживший → hash_a (король группы) */
  winner: FileMetadata;
  /** проигравший → hash_b (удаляется) */
  loser: FileMetadata;
  /** человекочитаемое обоснование (для таблицы/подсказки) */
  reason: string;
  /** true → различие надёжное, подходит для авто-резолва; false → в ручной разбор */
  confident: boolean;
}

const pick = (
  winner: FileMetadata,
  loser: FileMetadata,
  reason: string,
  confident: boolean,
): Decision => ({ winner, loser, reason, confident });

/**
 * Видео/анимации: разрешение → есть звук → больше кадров → дольше → размер → формат → старее.
 * Уверенно (авто) только при разном разрешении или разном наличии звука — остальное лишь
 * подсказка (видео рискованно удалять автоматически), уходит в ручной разбор.
 */
function decideMotion(a: FileMetadata, b: FileMetadata): Decision {
  const pa = pixels(a);
  const pb = pixels(b);
  if (pa !== pb) {
    const [w, l] = pa > pb ? [a, b] : [b, a];
    return pick(w, l, `higher resolution (${dims(w)} vs ${dims(l)})`, true);
  }
  if (hasAudio(a) !== hasAudio(b)) {
    const [w, l] = hasAudio(a) ? [a, b] : [b, a];
    return pick(w, l, "same resolution · has audio", true);
  }
  // дальше — только подсказка, уверенность низкая
  if (frames(a) !== frames(b)) {
    const [w, l] = frames(a) > frames(b) ? [a, b] : [b, a];
    return pick(w, l, `more frames (${frames(w)} vs ${frames(l)})`, false);
  }
  if (duration(a) !== duration(b)) {
    const [w, l] = duration(a) > duration(b) ? [a, b] : [b, a];
    return pick(w, l, `longer (${fmtDur(duration(w))} vs ${fmtDur(duration(l))})`, false);
  }
  if (a.size !== b.size) {
    const [w, l] = a.size > b.size ? [a, b] : [b, a];
    return pick(w, l, `larger file (${fmtSize(w.size)} vs ${fmtSize(l.size)})`, false);
  }
  const fa = formatRank(a);
  const fb = formatRank(b);
  if (fa !== fb) {
    const [w, l] = fa > fb ? [a, b] : [b, a];
    return pick(w, l, `better format (${ext(w)})`, false);
  }
  const [w, l] = importedAt(a) <= importedAt(b) ? [a, b] : [b, a];
  return pick(w, l, "indistinguishable · kept older import", false);
}

/**
 * Кто из пары «лучше».
 * - видео/анимации → decideMotion (см. выше).
 * - pixel-identical картинки: контент совпадает попиксельно → формат → меньший размер → старее.
 *   Тут «больше байт» ≠ лучше, поэтому предпочитаем компактный. Всегда confident (контент тот же).
 * - near-dupe картинки: разрешение → размер → формат → старее импорт (порядок согласован).
 *   confident только если различается разрешение; при равном разрешении решение есть,
 *   но уверенность низкая → по умолчанию уходит в ручной разбор.
 */
export function decide(a: FileMetadata, b: FileMetadata, pixelIdentical: boolean): Decision {
  if (isMotion(a) || isMotion(b)) return decideMotion(a, b);

  if (pixelIdentical) {
    const fa = formatRank(a);
    const fb = formatRank(b);
    if (fa !== fb) {
      const [w, l] = fa > fb ? [a, b] : [b, a];
      return pick(w, l, `identical pixels · better format (${ext(w)} over ${ext(l)})`, true);
    }
    if (a.size !== b.size) {
      const [w, l] = a.size < b.size ? [a, b] : [b, a];
      return pick(w, l, `identical pixels · smaller (${fmtSize(w.size)} vs ${fmtSize(l.size)})`, true);
    }
    const [w, l] = importedAt(a) <= importedAt(b) ? [a, b] : [b, a];
    return pick(w, l, "identical · kept older import", true);
  }

  const pa = pixels(a);
  const pb = pixels(b);
  if (pa !== pb) {
    const [w, l] = pa > pb ? [a, b] : [b, a];
    return pick(w, l, `higher resolution (${dims(w)} vs ${dims(l)})`, true);
  }
  // дальше разрешение равно → уверенность низкая, решение всё равно отдаём
  if (a.size !== b.size) {
    const [w, l] = a.size > b.size ? [a, b] : [b, a];
    return pick(w, l, `same resolution · larger file (${fmtSize(w.size)} vs ${fmtSize(l.size)})`, false);
  }
  const fa = formatRank(a);
  const fb = formatRank(b);
  if (fa !== fb) {
    const [w, l] = fa > fb ? [a, b] : [b, a];
    return pick(w, l, `same resolution & size · better format (${ext(w)})`, false);
  }
  const [w, l] = importedAt(a) <= importedAt(b) ? [a, b] : [b, a];
  return pick(w, l, "indistinguishable · kept older import", false);
}
