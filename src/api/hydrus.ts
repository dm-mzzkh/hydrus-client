import type { Settings } from "../config";

/** Теги одного тег-сервиса в ответе file_metadata. */
interface ServiceTags {
  name: string;
  type: number;
  /** status ("0" = current, "1" = pending, ...) → список тегов */
  storage_tags?: Record<string, string[]>;
  display_tags?: Record<string, string[]>;
}

export interface FileMetadata {
  file_id: number;
  hash: string;
  ext: string;
  size: number;
  mime: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  has_audio: boolean | null;
  num_frames: number | null;
  /** keyed by service_key */
  tags?: Record<string, ServiceTags>;
}

/**
 * Тонкий типизированный клиент Hydrus Client API.
 * Документация эндпоинтов: https://hydrusnetwork.github.io/hydrus/client_api.html
 */
export class HydrusApi {
  constructor(private settings: Settings) {}

  private get base(): string {
    return this.settings.baseUrl.replace(/\/+$/, "");
  }

  /** Для fetch — ключ кладём в заголовок (CORS-preflight Hydrus обрабатывает сам). */
  private get headers(): HeadersInit {
    return { "Hydrus-Client-API-Access-Key": this.settings.accessKey };
  }

  async verify(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/verify_access_key`, { headers: this.headers });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * Возвращает ВЕСЬ список file_id под запрос (пагинации на сервере нет — листаем сами).
   * tags — массив, напр. ["character:samus", "blue eyes"] или ["system:everything"].
   */
  async searchFiles(tags: string[]): Promise<number[]> {
    const url = new URL(`${this.base}/get_files/search_files`);
    url.searchParams.set("tags", JSON.stringify(tags));
    // Сортировки см. file_sort_type в доке (size, import time, num tags, random, ...).
    // По умолчанию оставляем серверный порядок.
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`search_files: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { file_ids: number[] };
    return data.file_ids;
  }

  /** Полные метаданные одного файла (с тегами) — дёргаем при открытии просмотра. */
  async fileMetadata(fileId: number): Promise<FileMetadata> {
    const url = new URL(`${this.base}/get_files/file_metadata`);
    url.searchParams.set("file_ids", JSON.stringify([fileId]));
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`file_metadata: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { metadata: FileMetadata[] };
    return data.metadata[0];
  }

  /**
   * URL миниатюры/файла для <img>/<video>. Заголовки на медиа-теги не повесить,
   * поэтому ключ передаём query-параметром (Client API это поддерживает).
   * URL стабилен по file_id → браузер кеширует агрессивно (контент иммутабелен).
   */
  thumbnailUrl(fileId: number): string {
    return `${this.base}/get_files/thumbnail?file_id=${fileId}&Hydrus-Client-API-Access-Key=${this.keyParam}`;
  }

  fileUrl(fileId: number): string {
    return `${this.base}/get_files/file?file_id=${fileId}&Hydrus-Client-API-Access-Key=${this.keyParam}`;
  }

  private get keyParam(): string {
    return encodeURIComponent(this.settings.accessKey);
  }
}

/** Собирает текущие display-теги по всем сервисам в плоский отсортированный список. */
export function collectTags(meta: FileMetadata): string[] {
  const out = new Set<string>();
  for (const svc of Object.values(meta.tags ?? {})) {
    for (const t of svc.display_tags?.["0"] ?? []) out.add(t);
  }
  return [...out].sort();
}
