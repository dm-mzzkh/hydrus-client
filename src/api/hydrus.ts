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

/** Поисковые параметры для эндпоинтов потенциальных дублей (manage_file_relationships). */
export interface PotentialsQuery {
  /** предикаты поиска (как в searchFiles) → tags_1 */
  tags: string[];
  /** скоуп по тег-сервису → tag_service_key_1 */
  tagServiceKey?: string;
  /** potentials_search_type: 0 = один файл матчит, 1 = оба матчат (по умолч.), 2 = A матчит 1 / B матчит 2 */
  searchType?: number;
  /** pixel_duplicates: 0 = обязаны быть пиксель-идентичны, 1 = могут (по умолч.), 2 = не должны */
  pixelDuplicates?: number;
  /** max_hamming_distance — «строгость» поиска похожих (по умолч. 4); игнор при pixelDuplicates=0 */
  maxHammingDistance?: number;
  /** max_num_pairs — размер батча пар (только для potentialPairs) */
  maxNumPairs?: number;
  /** duplicate_pair_sort_type (только для potentialPairs); 0 = по размеру большего файла */
  sortType?: number;
}

/** Одна устанавливаемая связь для set_file_relationships. */
export interface RelationshipSet {
  /** выживший («король» группы) */
  hash_a: string;
  /** проигравший */
  hash_b: string;
  /** см. DUPLICATE; 4 = «A лучше B» */
  relationship: number;
  /** слить теги/рейтинги/urls по настройкам мерджа Hydrus */
  do_default_content_merge: boolean;
  delete_a?: boolean;
  delete_b?: boolean;
}

/** Значения enum relationship для set_file_relationships. */
export const DUPLICATE = {
  POTENTIAL: 0,
  FALSE_POSITIVE: 1,
  SAME_QUALITY: 2,
  ALTERNATE: 3,
  A_BETTER: 4,
} as const;

/** MIME-тип Flash (SWF) в Hydrus — браузер его не играет, гоняем через Ruffle. */
export const FLASH_MIME = "application/x-shockwave-flash";
export const isFlashMime = (mime?: string | null): boolean => mime === FLASH_MIME;

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
  known_urls?: string[];
  /** keyed by note name (только при include_notes=true) */
  notes?: Record<string, string>;
  time_imported?: number;
  time_modified?: number;
}

/**
 * Тонкий типизированный клиент Hydrus Client API.
 * Документация эндпоинтов: https://hydrusnetwork.github.io/hydrus/client_api.html
 */
export class HydrusApi {
  constructor(private settings: Settings) {}

  private servicesCache?: Promise<Record<string, ServiceInfo>>;
  private metaCache = new Map<number, Promise<FileMetadata>>(); // полные метаданные (с тегами)
  // базовые метаданные (mime/размеры/длительность, без тегов) — батчатся, отдельный кэш
  private basicCache = new Map<number, FileMetadata>();
  private basicWaiters = new Map<
    number,
    { promise: Promise<FileMetadata>; resolve: (m: FileMetadata) => void; reject: (e: unknown) => void }
  >();
  private basicTimer?: ReturnType<typeof setTimeout>;

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
   * (негатив), "system:inbox", "character:sam*" (wildcard). Вложенный массив = OR-группа.
   */
  async searchFiles(tags: (string | string[])[], opts: SearchOpts = {}): Promise<number[]> {
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

  /** Полные метаданные одного файла (с тегами), кешируются на инстанс. */
  fileMetadata(fileId: number): Promise<FileMetadata> {
    const cached = this.metaCache.get(fileId);
    if (cached) return cached;
    const p = this.fetchMetadata(fileId);
    this.metaCache.set(fileId, p);
    p.catch(() => this.metaCache.delete(fileId)); // не кешируем ошибку
    return p;
  }

  private async fetchMetadata(fileId: number): Promise<FileMetadata> {
    const url = new URL(`${this.base}/get_files/file_metadata`);
    url.searchParams.set("file_ids", JSON.stringify([fileId]));
    url.searchParams.set("include_notes", "true"); // заметки нужны сайдбару вьюера
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`file_metadata: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { metadata?: FileMetadata[] };
    const meta = data.metadata?.[0];
    if (!meta) throw new Error(`file_metadata: no metadata returned for file ${fileId}`);
    return meta;
  }

  /**
   * Базовые метаданные (mime/размеры/длительность/кадры, без тегов).
   * Запросы за ~60мс объединяются в один батч-вызов file_metadata.
   */
  basicMetadata(fileId: number): Promise<FileMetadata> {
    const cached = this.basicCache.get(fileId);
    if (cached) return Promise.resolve(cached);
    const existing = this.basicWaiters.get(fileId);
    if (existing) return existing.promise;

    let resolve!: (m: FileMetadata) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<FileMetadata>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.basicWaiters.set(fileId, { promise, resolve, reject });
    if (!this.basicTimer) this.basicTimer = setTimeout(() => this.flushBasic(), 60);
    return promise;
  }

  private async flushBasic(): Promise<void> {
    this.basicTimer = undefined;
    const batch = [...this.basicWaiters.entries()];
    this.basicWaiters = new Map();
    if (!batch.length) return;
    try {
      const url = new URL(`${this.base}/get_files/file_metadata`);
      url.searchParams.set("file_ids", JSON.stringify(batch.map(([id]) => id)));
      url.searchParams.set("only_return_basic_information", "true");
      const r = await fetch(url, { headers: this.headers });
      if (!r.ok) throw new Error(`file_metadata: ${r.status} ${r.statusText}`);
      const data = (await r.json()) as { metadata?: FileMetadata[] };
      const byId = new Map((data.metadata ?? []).map((m) => [m.file_id, m]));
      for (const [id, w] of batch) {
        const m = byId.get(id);
        if (m) {
          this.basicCache.set(id, m);
          w.resolve(m);
        } else {
          w.reject(new Error(`no basic metadata for ${id}`));
        }
      }
    } catch (e) {
      for (const [, w] of batch) w.reject(e);
    }
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

  // ---- запись (требует у ключа соответствующих прав) ----

  private async post(path: string, body: unknown): Promise<unknown> {
    const r = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`);
    return r.json().catch(() => ({}));
  }

  /** Сбросить кэш метаданных файла (после записи). */
  invalidateMetadata(fileId: number): void {
    this.metaCache.delete(fileId);
    this.basicCache.delete(fileId);
  }

  /** Добавить/удалить теги в локальном тег-сервисе (action 0 = add, 1 = delete). */
  async addTags(fileIds: number[], serviceKey: string, add: string[] = [], remove: string[] = []): Promise<void> {
    const actions: Record<string, string[]> = {};
    if (add.length) actions["0"] = add;
    if (remove.length) actions["1"] = remove;
    if (!Object.keys(actions).length) return;
    await this.post("/add_tags/add_tags", {
      file_ids: fileIds,
      service_keys_to_actions_to_tags: { [serviceKey]: actions },
    });
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }

  /** Рейтинг: true/false/null (like), int/null (numerical), int (inc/dec). */
  async setRating(fileIds: number[], ratingServiceKey: string, rating: boolean | number | null): Promise<void> {
    await this.post("/edit_ratings/set_rating", {
      file_ids: fileIds,
      rating_service_key: ratingServiceKey,
      rating,
    });
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }

  async archiveFiles(fileIds: number[]): Promise<void> {
    await this.post("/add_files/archive_files", { file_ids: fileIds });
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }
  async unarchiveFiles(fileIds: number[]): Promise<void> {
    await this.post("/add_files/unarchive_files", { file_ids: fileIds });
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }
  /**
   * Удалить файлы. По умолчанию (без fileServiceKey) — в корзину (combined local file domains).
   * Для физического удаления уже-в-корзине файлов передать fileServiceKey домена-хранилища
   * («all local files»/trash). reason — опциональная причина (пишется в лог удалений Hydrus).
   */
  async deleteFiles(
    fileIds: number[],
    opts?: { fileServiceKey?: string; reason?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = { file_ids: fileIds };
    if (opts?.fileServiceKey) body.file_service_key = opts.fileServiceKey;
    if (opts?.reason) body.reason = opts.reason;
    await this.post("/add_files/delete_files", body);
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }
  async undeleteFiles(fileIds: number[]): Promise<void> {
    await this.post("/add_files/undelete_files", { file_ids: fileIds });
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }

  /**
   * Импорт файла байтами (для локального импорта прямо из браузера — File/Blob).
   * status: 1 imported, 2 already in db, 3 previously deleted, 4 failed, 7 vetoed.
   * Нужны права Import Files у ключа.
   */
  async addFileBytes(bytes: Blob): Promise<{ status: number; hash?: string; note?: string }> {
    const r = await fetch(`${this.base}/add_files/add_file`, {
      method: "POST",
      headers: { ...this.headers, "Content-Type": "application/octet-stream" },
      body: bytes,
    });
    if (!r.ok) throw new Error(`add_file: ${r.status} ${r.statusText}`);
    return (await r.json()) as { status: number; hash?: string; note?: string };
  }

  /** Добавить теги по хэшам (у свежеимпортированного файла есть hash, а не file_id). */
  async addTagsByHash(hashes: string[], serviceKey: string, add: string[]): Promise<void> {
    if (!hashes.length || !add.length) return;
    await this.post("/add_tags/add_tags", {
      hashes,
      service_keys_to_actions_to_tags: { [serviceKey]: { "0": add } },
    });
  }

  /** Стереть запись об удалении — чтобы повторно импортнуть previously-deleted файл (status 3). */
  async clearFileDeletionRecord(hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    await this.post("/add_files/clear_file_deletion_record", { hashes });
  }

  /** Ключ первого локального тег-сервиса (type 5), либо undefined. */
  async localTagServiceKey(): Promise<string | undefined> {
    const svcs = await this.services();
    return Object.values(svcs).find((s) => s.type === 5)?.service_key;
  }

  /** Привязать/удалить known-url у файлов. Эндпоинт работает по хэшам, не file_id. */
  async associateUrl(hashes: string[], add: string[] = [], remove: string[] = []): Promise<void> {
    if (!add.length && !remove.length) return;
    const body: Record<string, unknown> = { hashes };
    if (add.length) body.urls_to_add = add;
    if (remove.length) body.urls_to_delete = remove;
    await this.post("/add_urls/associate_url", body);
  }

  /**
   * Установить заметки (notes = { имя: текст }) на каждый файл. Эндпоинт set_notes
   * принимает ТОЛЬКО один файл (file_id), поэтому батч — это пер-файловый цикл.
   */
  async setNotes(fileIds: number[], notes: Record<string, string>): Promise<void> {
    if (!Object.keys(notes).length || !fileIds.length) return;
    await Promise.all(fileIds.map((id) => this.post("/add_notes/set_notes", { file_id: id, notes })));
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }

  /** Удалить заметки по именам. delete_notes тоже только по одному файлу — цикл. */
  async deleteNotes(fileIds: number[], noteNames: string[]): Promise<void> {
    if (!noteNames.length || !fileIds.length) return;
    await Promise.all(
      fileIds.map((id) => this.post("/add_notes/delete_notes", { file_id: id, note_names: noteNames })),
    );
    fileIds.forEach((id) => this.invalidateMetadata(id));
  }

  // ---- дубли / отношения файлов (требует право Manage File Relationships) ----

  /** Общие поисковые параметры для get_potentials_count / get_potential_pairs. */
  private applyPotentialsParams(url: URL, q: PotentialsQuery): void {
    url.searchParams.set("tags_1", JSON.stringify(q.tags));
    if (q.tagServiceKey) url.searchParams.set("tag_service_key_1", q.tagServiceKey);
    url.searchParams.set("potentials_search_type", String(q.searchType ?? 1));
    url.searchParams.set("pixel_duplicates", String(q.pixelDuplicates ?? 1));
    url.searchParams.set("max_hamming_distance", String(q.maxHammingDistance ?? 4));
  }

  /** Число оставшихся потенциальных пар дублей в заданном поисковом домене. */
  async potentialsCount(q: PotentialsQuery): Promise<number> {
    const url = new URL(`${this.base}/manage_file_relationships/get_potentials_count`);
    this.applyPotentialsParams(url, q);
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`get_potentials_count: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { potential_duplicates_count: number };
    return data.potential_duplicates_count;
  }

  /** Батч пар [hashA, hashB] для фильтрации. Хэши — всегда «короли», доступные в домене. */
  async potentialPairs(q: PotentialsQuery): Promise<[string, string][]> {
    const url = new URL(`${this.base}/manage_file_relationships/get_potential_pairs`);
    this.applyPotentialsParams(url, q);
    if (q.maxNumPairs !== undefined) url.searchParams.set("max_num_pairs", String(q.maxNumPairs));
    if (q.sortType !== undefined) url.searchParams.set("duplicate_pair_sort_type", String(q.sortType));
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`get_potential_pairs: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { potential_duplicate_pairs: [string, string][] };
    return data.potential_duplicate_pairs;
  }

  /** Установить связи (better/worse, same, alternate, false-positive) пакетом. */
  async setFileRelationships(relationships: RelationshipSet[]): Promise<void> {
    if (!relationships.length) return;
    await this.post("/manage_file_relationships/set_file_relationships", { relationships });
  }

  /**
   * Полные метаданные по списку хэшей (с тегами и time_imported — нужно для метадиффа
   * и comparator'а дублей). Не кешируем: после слияния дублей данные меняются, а батчи мелкие.
   */
  async metadataByHash(hashes: string[]): Promise<FileMetadata[]> {
    if (!hashes.length) return [];
    const url = new URL(`${this.base}/get_files/file_metadata`);
    url.searchParams.set("hashes", JSON.stringify(hashes));
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`file_metadata: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { metadata?: FileMetadata[] };
    return data.metadata ?? [];
  }

  /**
   * Полные метаданные пакетом по списку file_id одним запросом — для копирования
   * хэшей/known_urls выделения. Не кешируем: разовое действие, батч может быть большим.
   */
  async fileMetadataMany(fileIds: number[]): Promise<FileMetadata[]> {
    if (!fileIds.length) return [];
    const url = new URL(`${this.base}/get_files/file_metadata`);
    url.searchParams.set("file_ids", JSON.stringify(fileIds));
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) throw new Error(`file_metadata: ${r.status} ${r.statusText}`);
    const data = (await r.json()) as { metadata?: FileMetadata[] };
    return data.metadata ?? [];
  }

  /** URL миниатюры/файла по хэшу (эндпоинты дублей отдают хэши, не file_id). */
  thumbnailUrlByHash(hash: string): string {
    return `${this.base}/get_files/thumbnail?hash=${hash}&Hydrus-Client-API-Access-Key=${this.keyParam}`;
  }
  fileUrlByHash(hash: string): string {
    return `${this.base}/get_files/file?hash=${hash}&Hydrus-Client-API-Access-Key=${this.keyParam}`;
  }
}
