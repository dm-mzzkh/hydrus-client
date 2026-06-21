import { defineConfig, loadEnv, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, sep } from "node:path";

/**
 * Dev-only мост к gallery-dl. Браузер не может запускать локальные программы, поэтому раннер
 * живёт внутри dev-сервера как НЕЗАВИСИМЫЙ от запроса джоб. Модель «скачать ≠ импортировать»:
 *
 *   POST /start    { urls, tags }        → джоб; в фоне `gallery-dl -g` (список), затем фаза listed
 *                                          сразу, а проверка в Hydrus (get_url_files) идёт в ФОНЕ
 *                                          (флаг checking); отдаёт { jobId }
 *   GET  /status?jobId&itemsRev=N        → снимок; если N == текущей версии items, items не шлём
 *                                          (дельта — большой список не гоняется каждую секунду)
 *   POST /download { jobId, ids, force, → качает выбранные в ПОСТОЯННЫЙ кэш-стейджинг (медиа+теги),
 *                  autoImport,           в Hydrus НЕ пишет; force = качать даже если в кэше;
 *                  importForce }         autoImport = «скачать и импорт» (импорт каждого сразу)
 *   POST /import   { jobId, keys, force }→ заливает staged-файлы в Hydrus пулом (add_file+теги+urls);
 *                                          force = «добавить, даже если в БД / удалён» (clear deletion)
 *   GET  /jobs                           → список всех джобов (менеджер импортов)
 *   GET  /cached?key                     → отдаёт байты кэшированного медиа (превью/полный просмотр)
 *   POST /clear-cache                    → стереть весь кэш (стейджинг + карта url→hash)
 *   POST /remove   { jobId }             → выкинуть джоб из менеджера (kill + удалить temp)
 *   POST /stop     { jobId }             → отменить: kill процесса скачивания + отмена импорта
 *   POST /tags     { jobId, tags }       → обновить «теги для всех» на лету
 *   POST /staged-tags { jobId, key,     → правка тегов ОДНОГО staged-файла (add/remove);
 *                  add?, remove? }        если уже импортирован — сразу пишет в Hydrus
 *
 * Кэш-стейджинг и карта переживают перезагрузку страницы И перезапуск dev-сервера (лежат на диске).
 * Требует в .env: VITE_HYDRUS_URL, VITE_HYDRUS_KEY (права Import Files + Add Tags + Import URLs;
 * для проверки в БД ещё Search/Fetch). gallery-dl должен быть в PATH (или GALLERYDL_BIN).
 */
function galleryDlPlugin(env: Record<string, string>): Plugin {
  const base = (env.VITE_HYDRUS_URL || "http://localhost:45869").replace(/\/+$/, "");
  const key = env.VITE_HYDRUS_KEY || "";
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(base);
  const bin = process.env.GALLERYDL_BIN || "gallery-dl";
  const keyHeader = { "Hydrus-Client-API-Access-Key": key };
  const gdlEnv = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };

  // ---------- постоянный кэш на диске (переживает перезапуск dev-сервера) ----------
  const cacheDir = join(tmpdir(), "hydrus-gdl-cache");
  const stagingDir = join(cacheDir, "staging");      // тут лежат скачанные медиа-файлы
  const manifestPath = join(cacheDir, "staging.json"); // key → {media, name, tags, urls, fileUrl}
  const importedMapPath = join(cacheDir, "imported.json"); // прямой url файла → Hydrus-хэш (фолбэк проверки БД)

  type Manifest = Record<string, { media: string; name: string; tags: string[]; urls: string[]; fileUrl?: string }>;
  const manifest: Manifest = {};
  const importedMap = new Map<string, string>();
  let loaded = false;
  async function loadCache() {
    if (loaded) return;
    loaded = true;
    try { Object.assign(manifest, JSON.parse(await readFile(manifestPath, "utf8"))); } catch { /* нет файла */ }
    try {
      const j = JSON.parse(await readFile(importedMapPath, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(j)) importedMap.set(k, v);
    } catch { /* нет файла */ }
    clog("cache loaded · staged:", Object.keys(manifest).length, "· map:", importedMap.size);
  }
  let saveT: ReturnType<typeof setTimeout> | undefined;
  function saveCache() {
    if (saveT) return;
    saveT = setTimeout(() => {
      saveT = undefined;
      mkdir(cacheDir, { recursive: true })
        .then(() => Promise.all([
          writeFile(manifestPath, JSON.stringify(manifest)),
          writeFile(importedMapPath, JSON.stringify(Object.fromEntries(importedMap))),
        ]))
        .catch(() => {});
    }, 800);
  }

  // фиксированные аргументы gallery-dl: метаданные обязательны (из них берём url/теги), --write-tags
  const dlArgv = ["--cookies-from-browser", "firefox", "--write-tags", "--write-metadata"];
  const enumArgv = ["--cookies-from-browser", "firefox", "-g"];

  const SKIP = /\.(txt|json|part|sqlite|tmp)$/i;
  const isMedia = (p: string) => { const b = basename(p); return !b.startsWith(".") && !SKIP.test(b); };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const clog = (...a: unknown[]) => console.log("[gallery-dl]", ...a);
  const CT: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".mp4": "video/mp4", ".webm": "video/webm",
    ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  };

  const parseTags = (t: unknown): string[] => {
    const raw = typeof t === "string" ? t : Array.isArray(t) ? t.join("\n") : "";
    return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  };
  const readJson = async (req: { [Symbol.asyncIterator](): AsyncIterator<Buffer> }) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  };

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const name of await readdir(dir)) {
      const p = join(dir, name);
      const s = await stat(p);
      if (s.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  }

  // сайдкар тегов от --write-tags может появиться чуть позже файла → пара ретраев
  async function readTags(mediaPath: string, retries = 2): Promise<string[]> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      for (const cand of [mediaPath + ".txt", mediaPath.replace(/\.[^.]+$/, ".txt")]) {
        try {
          const t = await readFile(cand, "utf8");
          const tags = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (tags.length) return tags;
        } catch { /* нет сайдкара — пробуем следующее имя */ }
      }
      if (attempt < retries) await sleep(200);
    }
    return [];
  }

  // нормализация url под ключ кэша: убираем фрагмент и хвостовые пробелы, чтобы `-g`-URL
  // (на этапе списка) и прямой url из метаданных (на этапе стейджинга) совпадали как ключ
  const normUrl = (u: string) => u.trim().replace(/#.*$/, "");

  // собственные URL КАЖДОГО файла из JSON-сайдкара (страница поста + прямой url)
  function metaUrls(j: any): string[] {
    const out: string[] = [];
    const push = (u: unknown) => {
      if (typeof u === "string" && /^https?:\/\//i.test(u.trim())) out.push(u.trim());
      else if (Array.isArray(u)) for (const v of u) push(v);
    };
    switch (j.category) {
      case "furaffinity": if (j.id != null) push(`https://www.furaffinity.net/view/${j.id}/`); break;
      case "pixiv":       if (j.id != null) push(`https://www.pixiv.net/artworks/${j.id}`); break;
      case "twitter": {
        const tid = j.tweet_id ?? j.id, u = j.author?.name ?? j.user?.name;
        if (tid != null && u) push(`https://twitter.com/${u}/status/${tid}`);
        break;
      }
      case "danbooru": if (j.id != null) push(`https://danbooru.donmai.us/posts/${j.id}`); break;
      case "e621":     if (j.id != null) push(`https://e621.net/posts/${j.id}`); break;
      case "gelbooru": if (j.id != null) push(`https://gelbooru.com/index.php?page=post&s=view&id=${j.id}`); break;
      case "rule34":   if (j.id != null) push(`https://rule34.xxx/index.php?page=post&s=view&id=${j.id}`); break;
    }
    for (const k of ["post_url", "webpage_url", "page_url", "url", "file_url", "source", "sources"]) push(j[k]);
    return [...new Set(out)];
  }
  function metaTags(j: any): string[] {
    const out: string[] = [];
    const creator =
      j.artist ?? j.creator ?? j.uploader ??
      (typeof j.user === "string" ? j.user : j.user?.name ?? j.user?.account) ??
      (typeof j.author === "string" ? j.author : j.author?.name) ??
      j.username;
    if (typeof creator === "string" && creator.trim()) out.push(`creator:${creator.trim()}`);
    if (typeof j.title === "string" && j.title.trim()) out.push(`title:${j.title.trim()}`);
    return out;
  }
  // прямой URL загрузки файла (== тому, что выдаёт `gallery-dl -g`) — ключ кэша
  function metaFileUrl(j: any): string | undefined {
    for (const v of [j.file_url, j.url, j.file?.url]) {
      if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return normUrl(v);
    }
    return undefined;
  }
  // стабильный фолбэк-ключ, когда прямого url нет: category:id (+ basename для мульти-файловых
  // постов p0/p1). Не коллизит между сайтами, в отличие от голого basename.
  function metaIdKey(j: any): string | undefined {
    return (typeof j.category === "string" && j.id != null) ? `${j.category}:${j.id}` : undefined;
  }
  async function readMeta(mediaPath: string): Promise<{ urls: string[]; tags: string[]; fileUrl?: string; idKey?: string }> {
    for (const cand of [mediaPath + ".json", mediaPath.replace(/\.[^.]+$/, ".json")]) {
      try {
        const j = JSON.parse(await readFile(cand, "utf8"));
        return { urls: metaUrls(j), tags: metaTags(j), fileUrl: metaFileUrl(j), idKey: metaIdKey(j) };
      } catch { /* нет json / кривой — пробуем следующее имя */ }
    }
    return { urls: [], tags: [] };
  }

  // ---------- Hydrus Client API ----------
  async function localTagService(): Promise<string | undefined> {
    const r = await fetch(`${base}/get_services`, { headers: keyHeader });
    const data = (await r.json()) as { services_v2?: { service_key: string; type: number }[] };
    return (data.services_v2 ?? []).find((s) => s.type === 5)?.service_key;
  }

  // проверка «есть ли файл с этим URL в Hydrus»: 2=в БД, 3=удалён, пусто=не знает → наша карта
  async function dbCheck(url: string): Promise<{ status: "new" | "in_db" | "deleted"; hash?: string }> {
    try {
      const r = await fetch(`${base}/add_urls/get_url_files?url=${encodeURIComponent(url)}`, { headers: keyHeader });
      if (r.ok) {
        const d = (await r.json()) as { url_file_statuses?: { status: number; hash: string }[] };
        const st = d.url_file_statuses?.[0];
        if (st?.status === 2) return { status: "in_db", hash: st.hash };
        if (st?.status === 3) return { status: "deleted", hash: st.hash };
        if (st) return { status: "new", hash: st.hash };
      }
    } catch { /* нет прав / недоступно — фолбэк ниже */ }
    const h = importedMap.get(url);
    return h ? { status: "in_db", hash: h } : { status: "new" };
  }

  async function hydrusImport(absPath: string): Promise<{ status: number; hash?: string; note?: string }> {
    const r = isLocal
      ? await fetch(`${base}/add_files/add_file`, {
          method: "POST",
          headers: { ...keyHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ path: absPath }),
        })
      : await fetch(`${base}/add_files/add_file`, {
          method: "POST",
          headers: { ...keyHeader, "Content-Type": "application/octet-stream" },
          body: await readFile(absPath),
        });
    if (!r.ok) throw new Error(`add_file ${r.status} ${r.statusText}`);
    return r.json();
  }
  async function hydrusTags(hash: string, tags: string[], svc: string): Promise<void> {
    await fetch(`${base}/add_tags/add_tags`, {
      method: "POST",
      headers: { ...keyHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: [hash], service_keys_to_actions_to_tags: { [svc]: { "0": tags } } }),
    });
  }
  // добавить (action 0) и/или удалить (action 1) теги — для правки тегов уже импортированного файла
  async function hydrusTagEdit(hash: string, svc: string, add: string[], remove: string[]): Promise<void> {
    const actions: Record<string, string[]> = {};
    if (add.length) actions["0"] = add;
    if (remove.length) actions["1"] = remove;
    if (!Object.keys(actions).length) return;
    await fetch(`${base}/add_tags/add_tags`, {
      method: "POST",
      headers: { ...keyHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: [hash], service_keys_to_actions_to_tags: { [svc]: actions } }),
    });
  }
  async function hydrusAssociateUrls(hash: string, urls: string[]): Promise<void> {
    await fetch(`${base}/add_urls/associate_url`, {
      method: "POST",
      headers: { ...keyHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ hash, urls_to_add: urls }),
    });
  }
  async function hydrusClearDeletion(hash: string): Promise<void> {
    await fetch(`${base}/add_files/clear_file_deletion_record`, {
      method: "POST",
      headers: { ...keyHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ hashes: [hash] }),
    });
  }

  // ---------- реестр джобов ----------
  type DbStatus = "new" | "in_db" | "deleted";
  type Item = { id: number; urlIndex: number; rangeIndex: number; url: string; label: string; dbStatus: DbStatus; dbHash?: string; staged: boolean };
  // staged = скачанный в кэш файл (ещё не в Hydrus, пока не нажали Import)
  type Staged = { key: string; name: string; tags: string[]; urls: string[]; fileUrl?: string; dbStatus?: DbStatus; imported: boolean; status?: number; hash?: string; note?: string };
  type Phase = "enumerating" | "listed" | "downloading" | "done" | "stopped" | "error";
  interface Job {
    id: string;
    phase: Phase;
    checking: boolean;       // идёт фоновая проверка items в БД (после фазы listed)
    urls: string[];
    items: Item[];
    itemsRev: number;        // версия items — растёт при любой мутации (для дельта-опроса /status)
    tags: string[];          // «теги для всех», на лету
    staged: Staged[];
    importing: boolean;
    importStop: boolean;     // запрос на отмену импорта (см. /stop)
    autoImport: boolean;     // «скачать и импорт»: импортировать каждый файл сразу после стейджа
    importForce: boolean;    // force для авто-импорта («добавить даже если в БД / удалён»)
    downloaded: number;      // скачано в кэш в этом джобе
    cachedSkipped: number;   // взято из кэша без скачивания
    imported: number;        // залито в Hydrus
    failed: number;
    selectedCount: number;
    log: string[];
    error?: string;
    dir?: string;
    child?: ReturnType<typeof spawn>;
    createdAt: number;
  }
  const jobs = new Map<string, Job>();
  let seq = 0;
  let stageSeq = 0;
  const newId = () => `job-${Date.now().toString(36)}-${(seq++).toString(36)}`;

  // sinceRev: если совпадает с job.itemsRev — items не изменились, не шлём их (клиент держит копию)
  function snapshot(job: Job, sinceRev = -1) {
    return {
      id: job.id, phase: job.phase, checking: job.checking, urls: job.urls,
      items: sinceRev === job.itemsRev ? undefined : job.items, itemsRev: job.itemsRev,
      staged: job.staged, importing: job.importing,
      downloaded: job.downloaded, cachedSkipped: job.cachedSkipped,
      imported: job.imported, failed: job.failed, selectedCount: job.selectedCount,
      log: job.log.slice(-200), error: job.error,
    };
  }
  // краткая сводка джоба для менеджера импортов (список всех джобов)
  function jobSummary(job: Job) {
    return {
      id: job.id, phase: job.phase, checking: job.checking, importing: job.importing,
      label: job.urls[0] ?? job.id, urlCount: job.urls.length, items: job.items.length,
      staged: job.staged.length, imported: job.imported, failed: job.failed, createdAt: job.createdAt,
    };
  }
  function pruneJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      const terminal = job.phase === "done" || job.phase === "stopped" || job.phase === "error";
      if (terminal && !job.importing && now - job.createdAt > 2 * 60 * 60 * 1000) {
        if (job.dir) rm(job.dir, { recursive: true, force: true }).catch(() => {});
        jobs.delete(id);
      }
    }
  }
  function labelFor(url: string): string {
    try {
      const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
      return seg ? decodeURIComponent(seg) : url;
    } catch { return url; }
  }
  const pushLog = (job: Job, s: string) => { const t = s.trimEnd(); if (t && job.log.length < 5000) job.log.push(t); };

  // строит Staged из записи манифеста (для уже кэшированных файлов)
  function stagedFromManifest(key: string, dbStatus?: DbStatus): Staged {
    const m = manifest[key];
    return { key, name: m.name, tags: m.tags, urls: m.urls, fileUrl: m.fileUrl, dbStatus, imported: false };
  }

  // ---------- фаза 1: список + проверка в БД ----------
  function gdlGetUrls(job: Job, url: string): Promise<string[]> {
    return new Promise((resolve) => {
      const out: string[] = [];
      const child = spawn(bin, [...enumArgv, url], { env: gdlEnv });
      job.child = child;
      let buf = "";
      const flush = (line: string) => {
        const t = line.trim();
        if (/^https?:\/\//i.test(t)) out.push(t);
        else if (t) pushLog(job, t);
      };
      child.stdout?.on("data", (b: Buffer) => { buf += b.toString(); const ls = buf.split(/\r?\n/); buf = ls.pop() ?? ""; for (const l of ls) flush(l); });
      child.stderr?.on("data", (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) pushLog(job, l); });
      child.on("error", (e) => { pushLog(job, `spawn: ${e.message}`); resolve(out); });
      child.on("close", () => { if (buf) flush(buf); resolve(out); });
    });
  }

  async function runEnumerate(job: Job) {
    try {
      await loadCache();
      let gid = 0;
      for (let ui = 0; ui < job.urls.length; ui++) {
        if (job.phase === "stopped") return;
        const url = job.urls[ui];
        pushLog(job, `▶ listing ${url}`);
        const found = await gdlGetUrls(job, url);
        for (let i = 0; i < found.length; i++) {
          const u = normUrl(found[i]);
          job.items.push({ id: gid++, urlIndex: ui, rangeIndex: i + 1, url: u, label: labelFor(u), dbStatus: "new", staged: !!manifest[u] });
        }
        job.itemsRev++;
        pushLog(job, `  ${found.length} item(s)`);
      }
      job.child = undefined;
      // список готов — показываем его СРАЗУ, а проверку в БД гоним в фоне (статусы появляются
      // постепенно). Так пользователь не ждёт сотни round-trip к Hydrus на больших галереях.
      if (job.phase !== "stopped") { job.phase = "listed"; job.checking = true; }
      clog("listed", job.items.length, "item(s) — checking db in background");
      const B = 8;
      for (let i = 0; i < job.items.length; i += B) {
        if (job.phase === "stopped") break;
        await Promise.all(job.items.slice(i, i + B).map(async (it) => {
          const c = await dbCheck(it.url);
          it.dbStatus = c.status;
          it.dbHash = c.hash;
        }));
        job.itemsRev++;
      }
      job.checking = false;
      clog("db check done", job.items.length, "item(s)");
    } catch (e) {
      job.phase = "error"; job.error = String(e); job.checking = false;
      clog("enumerate error:", String(e));
    }
  }

  // ---------- фаза 2: скачать в кэш-стейджинг (БЕЗ импорта в Hydrus) ----------
  // кладёт скачанный файл в стейджинг, парсит метаданные, заносит в манифест и job.staged;
  // возвращает ключ (для авто-импорта) или undefined, если стейджить нечего
  async function stageFile(job: Job, f: string): Promise<string | undefined> {
    const meta = await readMeta(f);
    const tags = [...(await readTags(f)), ...job.tags, ...meta.tags];
    const key = meta.fileUrl ?? (meta.idKey ? `${meta.idKey}:${basename(f)}` : `path:${basename(f)}`);
    if (manifest[key] && job.staged.some((s) => s.key === key)) return key; // уже застейджено в этом джобе
    await mkdir(stagingDir, { recursive: true });
    const rel = `${Date.now().toString(36)}-${(stageSeq++).toString(36)}-${basename(f)}`;
    const dest = join(stagingDir, rel);
    try { await rename(f, dest); } catch { await copyFile(f, dest); }
    manifest[key] = { media: rel, name: basename(f), tags, urls: [...new Set(meta.urls)], fileUrl: meta.fileUrl };
    saveCache();
    const item = job.items.find((it) => it.url === key);
    job.staged.push({ key, name: basename(f), tags, urls: manifest[key].urls, fileUrl: meta.fileUrl, dbStatus: item?.dbStatus, imported: false });
    job.downloaded++;
    return key;
  }

  async function runDownload(job: Job, ids: number[], force = false, autoImport = false, importForce = false) {
    job.phase = "downloading";
    job.autoImport = autoImport;
    job.importForce = importForce;
    if (autoImport) job.importing = true; // «скачать и импорт»: блокирует параллельный ручной /import
    // job.phase может стать "stopped" из обработчика /stop посреди await — читаем через
    // замыкание, чтобы TS не сузил тип до литерала "downloading" и не счёл проверки мёртвыми
    const stopped = () => job.phase === "stopped";
    const chosen = new Set(ids);
    const want = job.items.filter((it) => chosen.has(it.id));
    job.selectedCount = want.length;
    // тег-сервис нужен только для авто-импорта — резолвим один раз
    const svc = autoImport ? await localTagService().catch(() => undefined) : undefined;
    let dir: string | undefined;
    try {
      await mkdir(stagingDir, { recursive: true });
      dir = await mkdtemp(join(tmpdir(), "gdl-"));
      job.dir = dir;

      // уже в кэше (если не force) → не качаем, сразу заносим в staged (и сразу импортим, если auto)
      for (const it of want) {
        if (!force && manifest[it.url]) {
          if (!job.staged.some((s) => s.key === it.url)) { job.staged.push(stagedFromManifest(it.url, it.dbStatus)); job.cachedSkipped++; }
          if (autoImport && !stopped()) await importOne(job, it.url, importForce, svc).catch((e) => clog("auto-import failed:", String(e)));
        }
      }
      const toFetch = want.filter((it) => force || !manifest[it.url]);

      // стейджим (и опц. импортим) по мере появления файлов в temp
      const queued = new Set<string>();
      const queue: string[] = [];
      let downloadsDone = false;
      const worker = (async () => {
        while (!stopped()) {
          const f = queue.shift();
          if (!f) { if (downloadsDone) break; await sleep(120); continue; }
          const k = await stageFile(job, f).catch((e) => { clog("stage failed:", String(e)); return undefined; });
          if (k && autoImport && !stopped()) await importOne(job, k, importForce, svc).catch((e) => clog("auto-import failed:", String(e)));
        }
      })();
      const poll = setInterval(() => {
        if (!dir) return;
        walk(dir).then((found) => { for (const f of found.filter(isMedia)) if (!queued.has(f)) { queued.add(f); queue.push(f); } }).catch(() => {});
      }, 1500);

      for (let ui = 0; ui < job.urls.length; ui++) {
        if (stopped()) break;
        const mine = job.items.filter((it) => it.urlIndex === ui);
        const idxs = toFetch.filter((it) => it.urlIndex === ui).map((it) => it.rangeIndex).sort((a, b) => a - b);
        if (!idxs.length) continue;
        const range = idxs.length === mine.length ? [] : ["--range", idxs.join(",")];
        pushLog(job, `▶ downloading ${job.urls[ui]} (${idxs.length}/${mine.length})`);
        await new Promise<void>((resolve) => {
          const child = spawn(bin, [...dlArgv, ...range, "-D", dir!, job.urls[ui]], { env: gdlEnv });
          job.child = child;
          let buf = "";
          const onChunk = (b: Buffer) => { buf += b.toString(); const ls = buf.split(/\r?\n/); buf = ls.pop() ?? ""; for (const l of ls) pushLog(job, l); };
          child.stdout?.on("data", onChunk);
          child.stderr?.on("data", onChunk);
          child.on("error", (e) => { pushLog(job, `spawn: ${e.message}`); resolve(); });
          child.on("close", (code) => { if (buf) pushLog(job, buf); pushLog(job, `gallery-dl finished (code ${code ?? "?"})`); resolve(); });
        });
      }

      clearInterval(poll);
      if (!stopped() && dir) {
        const found = (await walk(dir)).filter(isMedia);
        for (const f of found) if (!queued.has(f)) { queued.add(f); queue.push(f); }
      }
      downloadsDone = true;
      await worker.catch(() => {});
      job.child = undefined;
      if (!stopped()) job.phase = "done";
      clog("download done", { downloaded: job.downloaded, cached: job.cachedSkipped, imported: job.imported, phase: job.phase });
    } catch (e) {
      job.phase = "error"; job.error = String(e);
      clog("download error:", String(e));
    } finally {
      if (autoImport) job.importing = false;
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---------- фаза 3: импорт staged-файлов в Hydrus ----------
  // пул из POOL воркеров (Hydrus тянет add_file по одному, но конвейер из tags/urls/повторов
  // на каждый файл хорошо параллелится); прерывается через job.importStop (см. /stop)
  async function importOne(job: Job, k: string, force: boolean, svc: string | undefined) {
    const st = job.staged.find((s) => s.key === k);
    const m = manifest[k];
    if (!st || st.imported || !m) return;
    const path = join(stagingDir, m.media);
    try {
      let r = await hydrusImport(path);
      // previously deleted + «добавить всё равно» → стираем запись об удалении и повторяем
      if (r.status === 3 && force && r.hash) { await hydrusClearDeletion(r.hash).catch(() => {}); r = await hydrusImport(path); }
      st.status = r.status; st.hash = r.hash; st.note = r.note;
      if (r.hash && (r.status === 1 || r.status === 2)) {
        if (st.tags.length && svc) await hydrusTags(r.hash, st.tags, svc).catch(() => {});
        if (st.urls.length) await hydrusAssociateUrls(r.hash, st.urls).catch(() => {});
        if (st.fileUrl) { importedMap.set(st.fileUrl, r.hash); saveCache(); }
        st.imported = true;
        if (r.status === 1) job.imported++;
      } else if (r.status === 3) {
        st.note = "previously deleted — enable «add anyway» to restore";
      } else {
        job.failed++; // 4 failed / 7 vetoed — повтор не поможет (клиент прячет кнопку для veto)
      }
    } catch (e) {
      st.note = String(e); job.failed++;
    }
  }

  async function runImport(job: Job, keys: string[], force: boolean) {
    if (!key) { job.error = "VITE_HYDRUS_KEY not set in .env"; return; }
    job.importing = true;
    job.importStop = false;
    try {
      const svc = await localTagService().catch(() => undefined);
      const todo = keys.slice();
      const POOL = 4;
      const worker = async () => {
        while (!job.importStop) {
          const k = todo.shift();
          if (k === undefined) break;
          await importOne(job, k, force, svc);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL, todo.length)) }, () => worker()));
    } finally {
      job.importing = false;
    }
  }

  return {
    name: "gallery-dl-import",
    apply: "serve", // только dev-сервер: в продакшн-сборке плагин не участвует
    configureServer(server) {
      server.middlewares.use("/__gallerydl", async (req, res) => {
        const full = req.url ?? "";
        const path = full.split("?")[0];
        const query = new URLSearchParams(full.split("?")[1] || "");
        const json = (code: number, obj: unknown) => { res.statusCode = code; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };

        // GET /status?jobId&itemsRev=N — N даёт клиент; если совпало, items не шлём (дельта)
        if (req.method === "GET" && path.startsWith("/status")) {
          pruneJobs();
          const job = jobs.get(query.get("jobId") || "");
          if (!job) { json(404, { error: "no such job" }); return; }
          const since = Number(query.get("itemsRev"));
          json(200, snapshot(job, Number.isFinite(since) ? since : -1));
          return;
        }

        // GET /jobs — список всех джобов (менеджер импортов)
        if (req.method === "GET" && path.startsWith("/jobs")) {
          pruneJobs();
          json(200, { jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(jobSummary) });
          return;
        }

        // GET /cached?key=... — отдать байты кэшированного медиа (для превью/просмотра)
        if (req.method === "GET" && path.startsWith("/cached")) {
          await loadCache();
          const m = manifest[query.get("key") || ""];
          if (!m) { res.statusCode = 404; res.end(); return; }
          const file = join(stagingDir, m.media);
          // защита от traversal: проверяем границу по разделителю, а не префикс строки
          if (file !== stagingDir && !file.startsWith(stagingDir + sep)) { res.statusCode = 403; res.end(); return; }
          res.setHeader("Content-Type", CT[extname(file).toLowerCase()] || "application/octet-stream");
          // контент для key неизменен (key кодирует сам файл) → можно кэшировать в браузере
          res.setHeader("Cache-Control", "private, max-age=300");
          createReadStream(file).on("error", () => { res.statusCode = 404; res.end(); }).pipe(res);
          return;
        }

        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }

        // POST /start { urls, tags, jobId? }
        if (path.startsWith("/start")) {
          try {
            const body = await readJson(req);
            const urls: string[] = (Array.isArray(body.urls) ? body.urls : []).map(String).map((s: string) => s.trim()).filter(Boolean);
            if (!urls.length) { json(400, { error: "no urls" }); return; }
            pruneJobs();
            const id = (typeof body.jobId === "string" && body.jobId) || newId();
            const job: Job = {
              id, phase: "enumerating", checking: false, urls, items: [], itemsRev: 0,
              tags: parseTags(body.tags), staged: [],
              importing: false, importStop: false, autoImport: false, importForce: false,
              downloaded: 0, cachedSkipped: 0, imported: 0, failed: 0, selectedCount: 0,
              log: [], createdAt: Date.now(),
            };
            jobs.set(id, job);
            clog("start", id, "· urls=", urls.length, "· key=", !!key, "· isLocal=", isLocal);
            void runEnumerate(job);
            json(200, { jobId: id });
          } catch (e) { json(500, { error: String(e) }); }
          return;
        }

        // POST /download { jobId, ids, force, autoImport, importForce }
        if (path.startsWith("/download")) {
          try {
            const body = await readJson(req);
            const job = jobs.get(body.jobId);
            if (!job) { res.statusCode = 404; res.end(); return; }
            if (job.phase === "listed") {
              const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : job.items.map((it) => it.id);
              void runDownload(job, ids, body.force === true, body.autoImport === true, body.importForce === true);
            }
            res.statusCode = 204; res.end();
          } catch { res.statusCode = 400; res.end(); }
          return;
        }

        // POST /import { jobId, keys?, force } — залить staged-файлы в Hydrus
        if (path.startsWith("/import")) {
          try {
            const body = await readJson(req);
            const job = jobs.get(body.jobId);
            if (!job) { res.statusCode = 404; res.end(); return; }
            if (!job.importing) {
              const keys: string[] = Array.isArray(body.keys) && body.keys.length ? body.keys : job.staged.filter((s) => !s.imported).map((s) => s.key);
              void runImport(job, keys, body.force === true);
            }
            res.statusCode = 204; res.end();
          } catch { res.statusCode = 400; res.end(); }
          return;
        }

        // POST /clear-cache — стереть весь кэш-стейджинг + карту
        if (path.startsWith("/clear-cache")) {
          try {
            await rm(cacheDir, { recursive: true, force: true });
            for (const k of Object.keys(manifest)) delete manifest[k];
            importedMap.clear();
            clog("cache cleared");
            json(200, { ok: true });
          } catch (e) { json(500, { error: String(e) }); }
          return;
        }

        // POST /stop { jobId } — отменяет и скачивание (kill + phase), и импорт (importStop)
        if (path.startsWith("/stop")) {
          try {
            const body = await readJson(req); const job = jobs.get(body.jobId);
            if (job) {
              job.importStop = true;
              job.child?.kill();
              if (job.phase === "enumerating" || job.phase === "downloading") job.phase = "stopped";
            }
          } catch { /* ignore */ }
          res.statusCode = 204; res.end();
          return;
        }

        // POST /remove { jobId } — выкинуть джоб из менеджера (kill + удалить temp + забыть)
        if (path.startsWith("/remove")) {
          try {
            const body = await readJson(req); const job = jobs.get(body.jobId);
            if (job) {
              job.importStop = true;
              if (job.phase === "enumerating" || job.phase === "downloading") job.phase = "stopped";
              job.child?.kill();
              if (job.dir) rm(job.dir, { recursive: true, force: true }).catch(() => {});
              jobs.delete(body.jobId);
            }
          } catch { /* ignore */ }
          res.statusCode = 204; res.end();
          return;
        }

        // POST /staged-tags { jobId, key, add?, remove? } — правка тегов ОДНОГО staged-файла.
        // Меняет manifest+staged (применится при импорте); если файл уже импортирован — сразу в Hydrus.
        if (path.startsWith("/staged-tags")) {
          try {
            const body = await readJson(req);
            const job = jobs.get(body.jobId);
            const m = manifest[body.key];
            const add: string[] = (Array.isArray(body.add) ? body.add : []).map(String).map((s: string) => s.trim()).filter(Boolean);
            const remove: string[] = (Array.isArray(body.remove) ? body.remove : []).map(String).map((s: string) => s.trim()).filter(Boolean);
            if (m) {
              const set = new Set(m.tags);
              for (const t of remove) set.delete(t);
              for (const t of add) set.add(t);
              m.tags = [...set];
              const st = job?.staged.find((s) => s.key === body.key);
              if (st) {
                st.tags = m.tags;
                if (st.imported && st.hash) {
                  const svc = await localTagService().catch(() => undefined);
                  if (svc) await hydrusTagEdit(st.hash, svc, add, remove).catch(() => {});
                }
              }
              saveCache();
            }
          } catch { /* ignore */ }
          res.statusCode = 204; res.end();
          return;
        }

        // POST /tags { jobId, tags }
        if (path.startsWith("/tags")) {
          try { const body = await readJson(req); const job = jobs.get(body.jobId); if (job) job.tags = parseTags(body.tags); } catch { /* ignore */ }
          res.statusCode = 204; res.end();
          return;
        }

        res.statusCode = 404; res.end();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [solid(), galleryDlPlugin(env)],
    server: { port: 5173 },
  };
});
