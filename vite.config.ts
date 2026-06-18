import { defineConfig, loadEnv, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Dev-only мост к gallery-dl. Браузер не может запускать локальные программы,
 * поэтому раннер живёт внутри dev-сервера: POST /__gallerydl со списком URL →
 * gallery-dl качает во временную папку (с --write-tags) → каждый файл импортируется
 * в Hydrus по Client API (add_file + add_tags) → прогресс стримится обратно NDJSON.
 *
 * Требует в .env: VITE_HYDRUS_URL, VITE_HYDRUS_KEY (ключ с правами Import Files + Add Tags).
 * gallery-dl должен быть в PATH (или задай GALLERYDL_BIN).
 */
function galleryDlPlugin(env: Record<string, string>): Plugin {
  const base = (env.VITE_HYDRUS_URL || "http://localhost:45869").replace(/\/+$/, "");
  const key = env.VITE_HYDRUS_KEY || "";
  // если Hydrus на этой же машине — импортируем по пути (Hydrus читает файл сам), иначе шлём байты
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/|$)/i.test(base);
  const bin = process.env.GALLERYDL_BIN || "gallery-dl";
  const keyHeader = { "Hydrus-Client-API-Access-Key": key };

  const SKIP = /\.(txt|json|part|sqlite|tmp)$/i;
  const isMedia = (p: string) => { const b = basename(p); return !b.startsWith(".") && !SKIP.test(b); };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // «живые» доп-теги по jobId — можно дополнять во время скачивания (см. под-эндпоинт /tags)
  const jobs = new Map<string, string[]>();
  const parseTags = (t: unknown): string[] => {
    const raw = typeof t === "string" ? t : Array.isArray(t) ? t.join("\n") : "";
    return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  };
  const readJson = async (req: { [Symbol.asyncIterator](): AsyncIterator<Buffer> }) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  };

  function tokenize(s: string): string[] {
    const out: string[] = [];
    let cur = "";
    let q = "";
    for (const ch of s) {
      if (q) ch === q ? (q = "") : (cur += ch);
      else if (ch === '"' || ch === "'") q = ch;
      else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ""; } }
      else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

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
  async function readTags(mediaPath: string, retries = 0): Promise<string[]> {
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

  // из JSON-сайдкара (--write-metadata): точные URL поста и доп-теги (creator/title)
  function metaUrls(j: any): string[] {
    const out: string[] = [];
    if (j.category === "furaffinity" && j.id != null) out.push(`https://www.furaffinity.net/view/${j.id}/`);
    for (const k of ["post_url", "webpage_url", "page_url", "source"]) {
      if (typeof j[k] === "string" && /^https?:\/\//i.test(j[k])) out.push(j[k]);
    }
    return [...new Set(out)];
  }
  function metaTags(j: any): string[] {
    const out: string[] = [];
    const creator = j.artist ?? j.user ?? j.creator ?? j.uploader ?? j.username;
    if (typeof creator === "string" && creator.trim()) out.push(`creator:${creator.trim()}`);
    if (typeof j.title === "string" && j.title.trim()) out.push(`title:${j.title.trim()}`);
    return out;
  }
  async function readMeta(mediaPath: string): Promise<{ urls: string[]; tags: string[] }> {
    for (const cand of [mediaPath + ".json", mediaPath.replace(/\.[^.]+$/, ".json")]) {
      try {
        const j = JSON.parse(await readFile(cand, "utf8"));
        return { urls: metaUrls(j), tags: metaTags(j) };
      } catch { /* нет json / кривой — пробуем следующее имя */ }
    }
    return { urls: [], tags: [] };
  }

  async function localTagService(): Promise<string | undefined> {
    const r = await fetch(`${base}/get_services`, { headers: keyHeader });
    const data = (await r.json()) as { services_v2?: { service_key: string; type: number }[] };
    return (data.services_v2 ?? []).find((s) => s.type === 5)?.service_key;
  }

  async function hydrusImport(absPath: string): Promise<{ status: number; hash?: string; note?: string }> {
    const r = isLocal
      ? await fetch(`${base}/add_files/add_file`, {
          method: "POST",
          headers: { ...keyHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ path: absPath, delete_after_successful_import: true }),
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

  async function hydrusAssociateUrls(hash: string, urls: string[]): Promise<void> {
    await fetch(`${base}/add_urls/associate_url`, {
      method: "POST",
      headers: { ...keyHeader, "Content-Type": "application/json" },
      body: JSON.stringify({ hash, urls_to_add: urls }),
    });
  }

  return {
    name: "gallery-dl-import",
    configureServer(server) {
      server.middlewares.use("/__gallerydl", async (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }

        // под-эндпоинт: обновить доп-теги уже запущенного джоба (теги «на лету»)
        if ((req.url ?? "").startsWith("/tags")) {
          try {
            const body = await readJson(req);
            if (body.jobId && jobs.has(body.jobId)) jobs.set(body.jobId, parseTags(body.tags));
          } catch { /* кривой запрос — игнорируем */ }
          res.statusCode = 204;
          res.end();
          return;
        }

        res.setHeader("Content-Type", "application/x-ndjson");
        const send = (obj: unknown) => { try { res.write(JSON.stringify(obj) + "\n"); } catch { /* сокет закрыт */ } };
        const clog = (...a: unknown[]) => console.log("[gallery-dl]", ...a);

        let imported = 0, skipped = 0, failed = 0;
        let aborted = false;
        let downloadsDone = false;
        let dir: string | undefined;
        let svc: string | undefined;
        let wantTags = true;
        let extraTags: string[] = [];
        let jobId = "";
        let child: ReturnType<typeof spawn> | undefined;
        let poll: ReturnType<typeof setInterval> | undefined;
        // Реальная отмена = ответное соединение закрылось ДО res.end() (Stop в UI / уход со страницы).
        // ВАЖНО: слушаем res, а не req — у req событие 'close' на части версий Node срабатывает
        // сразу после дочитывания тела запроса, что ложно обрывало импорт.
        res.on("close", () => {
          const isAbort = !res.writableEnded;
          clog("res close · writableEnded =", res.writableEnded, isAbort ? "→ ABORT" : "(normal)");
          if (isAbort) { aborted = true; child?.kill(); }
        });

        // очередь импорта: готовые файлы (+ url-источник) добавляются по мере загрузки
        const queued = new Set<string>();
        const queue: { path: string; url: string }[] = [];
        const enqueue = (path: string, url: string) => {
          if (queued.has(path)) return;
          queued.add(path);
          queue.push({ path, url });
          clog("queued", basename(path), "(total", queued.size + ")");
          send({ type: "count", discovered: queued.size });
        };

        // воркер импортирует файлы параллельно загрузке, по одному
        const worker = (async () => {
          while (!aborted) {
            const item = queue.shift();
            if (item === undefined) {
              if (downloadsDone) break;
              await sleep(120);
              continue;
            }
            const { path: f, url: src } = item;
            try {
              // теги: sidecar (--write-tags) + живые доп-теги джоба + creator/title из метаданных
              const live = (jobId && jobs.get(jobId)) || extraTags;
              const meta = await readMeta(f);
              const tags = [...(await readTags(f, wantTags ? 2 : 0)), ...live, ...meta.tags];
              clog("import →", basename(f));
              const r = await hydrusImport(f);
              clog("  result: status", r.status, r.note ? `· ${r.note}` : "");
              if (r.status === 1) imported++;
              else if (r.status === 2 || r.status === 3) skipped++;
              else failed++;
              if (r.hash) {
                if (tags.length && svc) await hydrusTags(r.hash, tags, svc).catch(() => {});
                // точные URL поста из метаданных + URL запуска (галерея) как запасной
                const urls = [...new Set([...meta.urls, src].filter(Boolean))];
                if (urls.length) await hydrusAssociateUrls(r.hash, urls).catch(() => {});
              }
              send({ type: "file", name: basename(f), status: r.status, hash: r.hash, tags: tags.length, note: r.note });
            } catch (e) {
              failed++;
              clog("import FAILED:", basename(f), "·", String(e));
              send({ type: "error", message: String(e) });
            }
          }
        })();

        try {
          const body = await readJson(req);
          const urls: string[] = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
          const argv = tokenize(body.args ?? "--cookies-from-browser firefox --write-tags --write-metadata");
          wantTags = argv.includes("--write-tags");
          extraTags = parseTags(body.tags);
          jobId = typeof body.jobId === "string" ? body.jobId : "";
          if (jobId) jobs.set(jobId, extraTags);
          clog("request · urls=", urls.length, "· key=", !!key, "· isLocal=", isLocal, "· hydrus=", base);

          if (!key) {
            send({ type: "error", message: "VITE_HYDRUS_KEY not set in .env — the runner needs a server-side access key" });
            return;
          }
          dir = await mkdtemp(join(tmpdir(), "gdl-"));
          clog("tmp dir:", dir);
          svc = await localTagService().catch(() => undefined);
          send({ type: "log", line: `runner ready · ${urls.length} url(s)${extraTags.length ? ` · +${extraTags.length} tags` : ""}` });

          // импортируем готовые файлы по мере появления: периодически сканируем temp-папку.
          // надёжнее парсинга stdout — не зависит от формата путей gallery-dl (/var vs /private/var).
          // .part-файлы (ещё качаются) отсекаются в isMedia, поэтому берём только дописанные.
          let currentUrl = "";
          poll = setInterval(() => {
            if (!dir) return;
            walk(dir).then((found) => { for (const f of found.filter(isMedia)) enqueue(f, currentUrl); }).catch(() => {});
          }, 1500);

          for (const url of urls) {
            if (aborted) break;
            currentUrl = url;
            send({ type: "log", line: `▶ gallery-dl ${url}` });
            await new Promise<void>((resolve) => {
              child = spawn(bin, [...argv, "-D", dir!, url], {
                env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` },
              });
              let lineBuf = "";
              const handle = (l: string) => send({ type: "log", line: l });
              const onChunk = (b: Buffer) => {
                lineBuf += b.toString();
                const lines = lineBuf.split(/\r?\n/);
                lineBuf = lines.pop() ?? "";
                for (const l of lines) if (l) handle(l);
              };
              child.stdout?.on("data", onChunk);
              child.stderr?.on("data", onChunk);
              child.on("error", (e) => { send({ type: "error", message: `spawn: ${e.message}` }); resolve(); });
              child.on("close", (code) => { if (lineBuf) handle(lineBuf); clog("gallery-dl exit code", code); send({ type: "log", line: `gallery-dl finished (code ${code ?? "?"})` }); resolve(); });
            });
          }

          if (poll) { clearInterval(poll); poll = undefined; }
          // финальный проход — забираем всё, что докачалось после последнего скана
          if (dir && !aborted) {
            const found = (await walk(dir)).filter(isMedia);
            clog("final scan:", found.length, "media file(s) in tmp");
            const fallbackUrl = urls.length === 1 ? urls[0] : "";
            for (const f of found) enqueue(f, fallbackUrl);
          }
        } catch (e) {
          clog("handler error:", String(e));
          send({ type: "error", message: String(e) });
        } finally {
          if (poll) { clearInterval(poll); poll = undefined; }
          downloadsDone = true;
          await worker.catch(() => {});
          if (jobId) jobs.delete(jobId);
          clog("done", { imported, skipped, failed, aborted });
          send({ type: "done", imported, skipped, failed, aborted });
          if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
          try { res.end(); } catch { /* сокет уже закрыт */ }
        }
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
