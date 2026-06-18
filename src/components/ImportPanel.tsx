import { createSignal, For, Show } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { TagInput } from "./TagInput";
import { TagLabel } from "./TagLabel";

interface Props {
  api: HydrusApi;
  /** imported = сколько реально добавилось (родитель перезапустит поиск, если > 0) */
  onClose: (imported: number) => void;
}

interface FileResult {
  type: "file";
  name: string;
  status: number;
  hash?: string;
  tags: number;
  note?: string;
}

const STATUS_LABEL: Record<number, string> = {
  1: "imported",
  2: "already in db",
  3: "prev. deleted",
  4: "failed",
  7: "vetoed",
};

export function ImportPanel(props: Props) {
  const [urls, setUrls] = createSignal("");
  const [tagList, setTagList] = createSignal<string[]>([]);
  const [args, setArgs] = createSignal("--cookies-from-browser firefox --write-tags --write-metadata");
  const [running, setRunning] = createSignal(false);
  const [log, setLog] = createSignal<string[]>([]);
  const [files, setFiles] = createSignal<FileResult[]>([]);
  const [discovered, setDiscovered] = createSignal(0);
  const [summary, setSummary] = createSignal<string | null>(null);
  let importedCount = 0;
  let controller: AbortController | undefined;
  let jobId = "";

  // во время запущенного импорта проталкиваем обновлённый список тегов на сервер,
  // чтобы он применялся к файлам, импортируемым дальше
  function syncTags(next: string[]) {
    if (running() && jobId) {
      fetch("/__gallerydl/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, tags: next }),
      }).catch(() => {});
    }
  }
  const addTag = (t: string) => {
    const v = t.trim();
    if (!v || tagList().includes(v)) return;
    const next = [...tagList(), v];
    setTagList(next);
    syncTags(next);
  };
  const removeTag = (t: string) => {
    const next = tagList().filter((x) => x !== t);
    setTagList(next);
    syncTags(next);
  };

  function handleEvent(ev: { type: string; [k: string]: unknown }) {
    if (ev.type === "log") setLog((l) => [...l, String(ev.line)]);
    else if (ev.type === "error") setLog((l) => [...l, `⚠ ${String(ev.message)}`]);
    else if (ev.type === "count") setDiscovered(Number(ev.discovered) || 0);
    else if (ev.type === "file") {
      setFiles((f) => [...f, ev as unknown as FileResult]);
      if (ev.status === 1) importedCount++;
    } else if (ev.type === "done") {
      setSummary(
        `imported ${ev.imported} · skipped ${ev.skipped} · failed ${ev.failed}${ev.aborted ? " · stopped" : ""}`,
      );
    }
  }

  async function start() {
    const list = urls().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!list.length || running()) return;
    setRunning(true);
    setLog([]);
    setFiles([]);
    setDiscovered(0);
    setSummary(null);
    importedCount = 0;
    controller = new AbortController();
    jobId = crypto.randomUUID();
    try {
      const res = await fetch("/__gallerydl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ urls: list, args: args(), tags: tagList(), jobId }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`runner error ${res.status} — is the dev server running?`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) handleEvent(JSON.parse(line));
      }
    } catch (e) {
      setLog((l) => [...l, (e as Error)?.name === "AbortError" ? "⏹ stopped" : `error: ${String(e)}`]);
    } finally {
      setRunning(false);
      controller = undefined;
    }
  }

  function stop() {
    controller?.abort();
    setLog((l) => [...l, "⏹ stopping…"]);
  }

  const close = () => { if (!running()) props.onClose(importedCount); };

  return (
    <div class="overlay" onClick={close}>
      <div class="importer" onClick={(e) => e.stopPropagation()}>
        <div class="imp-head">
          <strong>Import via gallery-dl</strong>
          <button class="close" onClick={close} disabled={running()} aria-label="Close">✕</button>
        </div>

        <label class="imp-field">
          <span class="imp-label">URLs <span class="muted">— one per line</span></span>
          <textarea
            class="imp-urls"
            placeholder=""
            value={urls()}
            onInput={(e) => setUrls(e.currentTarget.value)}
            disabled={running()}
            spellcheck={false}
          />
        </label>

        <div class="imp-field">
          <span class="imp-label">Tags for all imported <span class="muted">— editable during download · post URL + creator/title auto-recorded from metadata</span></span>
          <Show when={tagList().length}>
            <div class="imp-chips">
              <For each={tagList()}>
                {(t) => (
                  <span class="chip">
                    <TagLabel value={t} />
                    <button class="chip-x" onClick={() => removeTag(t)} aria-label="Remove">×</button>
                  </span>
                )}
              </For>
            </div>
          </Show>
          <TagInput api={props.api} placeholder="add tag…" onPick={addTag} />
        </div>

        <details class="imp-adv">
          <summary>gallery-dl options</summary>
          <input value={args()} onInput={(e) => setArgs(e.currentTarget.value)} disabled={running()} spellcheck={false} />
        </details>

        <div class="imp-bar">
          <Show
            when={running()}
            fallback={<button class="imp-go" onClick={start} disabled={!urls().trim()}>Start</button>}
          >
            <button class="imp-go danger" onClick={stop}>Stop</button>
          </Show>
          <Show when={running()}>
            <span class="muted">{files().length} / {discovered() || "…"} processed</span>
          </Show>
          <Show when={!running() && summary()}>
            <span class="muted">{summary()}</span>
          </Show>
        </div>

        <Show when={files().length}>
          <div class="imp-section">
            <span class="imp-label">Imported <span class="muted">{files().length}</span></span>
            <div class="imp-results">
              <For each={files()}>
                {(f) => (
                  <div class="imp-file">
                    <Show when={f.hash} fallback={<div class="imp-thumb" />}>
                      <img class="imp-thumb" src={props.api.thumbnailUrlByHash(f.hash!)} loading="lazy" decoding="async" />
                    </Show>
                    <span class="imp-name" title={f.name}>{f.name}</span>
                    <span class="muted">{f.tags} tags</span>
                    <span
                      class="imp-status"
                      title={f.note || ""}
                      classList={{
                        ok: f.status === 1,
                        dim: f.status === 2 || f.status === 3,
                        bad: f.status === 4 || f.status === 7,
                      }}
                    >
                      {STATUS_LABEL[f.status] ?? f.status}{f.status !== 1 && f.note ? ` · ${f.note}` : ""}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={log().length}>
          <details class="imp-adv">
            <summary>Log <span class="muted">({log().length})</span></summary>
            <pre class="imp-log">{log().join("\n")}</pre>
          </details>
        </Show>
      </div>
    </div>
  );
}
