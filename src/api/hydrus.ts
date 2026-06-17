import type { Settings } from "../config";

/** Теги одного тег-сервиса в ответе file_metadata. */
export interface ServiceTags {
  name: string;
  type: number;
  /** status ("0" = current, "1" = deleted, "2" = pending, "3" = petitioned) */
  storage_tags?: Record<string, string[]>;
  display_tags?: Record<string, string[]>;
}

/** Рейтинг одного сервиса в ответе file_metadata. */
export interface RatingEntry {
  name: string;
  /** 6 = numerical, 7 = like/dislike, 22 = inc/dec */
  type: number;
  rating: boolean | number | null;
}

/** Сервис из /get_services (нужен max_stars для числовых рейтингов). */
export interface ServiceInfo {
  name: string;
  service_key: string;
  type: number;
  type_pretty?: string;
  min_stars?: number;
  max_stars?: number;
  allows_zero?: boolean;
}

export interface TagSuggestion {
  value: string;
  count: number;
}

export interface SearchOpts {
  /** file_sort_type (0..27), см. доку Client API */
  sortType?: number;
  /** true = по возрастанию; по умолчанию (omit) Hydrus сортирует по убыванию */
  sortAsc?: boolean;
  /** скоуп по тег-сервису (домену); пусто = "all known tags" */
  tagServiceKey?: string;
  /** скоуп по файловому домену */
  fileServiceKey?: string;
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
  /** keyed by service_key */
  ratings?: Record<string, RatingEntry>;
}

/**
 * Тонкий типизированный клиент Hydrus Client API.
 * Документация эндпоинтов: https://hydrusnetwork.github.io/hydrus/client_api.html
 */
export class HydrusApi {
  constructor(private settings: Settings) {}

  private servicesCache?: Promise<Record<string, ServiceInfo>>;

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
   * tags — массив строк-предикатов (как в клиенте): "character:samus", "-blue eyes"
   * (негатив), "system:inbox", "character:sam*" (wildcard).
   */
  async searchFiles(tags: string[], opts: SearchOpts = {}): Promise<number[]> {
    const url = new URL(`${this.base}/get_files/search_files`);
    url.searchParams.set("tags", JSON.stringify(tags));
    if (opts.sortType !== undefined) url.searchParams.set("file_sort_type", String(opts.sortType));
    if (opts.sortAsc !== undefined) url.searchParams.set("file_sort_asc", String(opts.sortAsc));
    if (opts.tagServiceKey) url.searchParams.set("tag_service_key", opts.tagServiceKey);
    if (opts.fileServiceKey) url.searchParams.set("file_service_key", opts.fileServiceKey);
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
    const data = (await r.json()) as { metadata?: FileMetadata[] };
    const meta = data.metadata?.[0];
    if (!meta) throw new Error(`file_metadata: no metadata returned for file ${fileId}`);
    return meta;
  }

  /** Список сервисов (кешируется на инстанс) — для max_stars числовых рейтингов. */
  services(): Promise<Record<string, ServiceInfo>> {
    if (!this.servicesCache) {
      this.servicesCache = (async () => {
        const r = await fetch(`${this.base}/get_services`, { headers: this.headers });
        if (!r.ok) throw new Error(`get_services: ${r.status} ${r.statusText}`);
        const data = (await r.json()) as { services_v2?: ServiceInfo[] };
        const map: Record<string, ServiceInfo> = {};
        for (const s of data.services_v2 ?? []) map[s.service_key] = s;
        return map;
      })();
    }
    return this.servicesCache;
  }

  /** Автокомплит тегов — работает как поле ввода тегов в самом Hydrus. */
  async searchTags(partial: string, tagServiceKey?: string): Promise<TagSuggestion[]> {
    const url = new URL(`${this.base}/add_tags/search_tags`);
    url.searchParams.set("search", partial);
    if (tagServiceKey) url.searchParams.set("tag_service_key", tagServiceKey);
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`search_tags: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { tags: TagSuggestion[] };
    return data.tags;
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
