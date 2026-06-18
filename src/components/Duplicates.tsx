import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { DUPLICATE, type FileMetadata, type HydrusApi, type RelationshipSet } from "../api/hydrus";
import { pushToast } from "../toast";
import { decide, mediaInfo, type Decision } from "../dupes";

interface Props {
  api: HydrusApi;
  /** предикаты текущего поиска (скоуп пар) */
  tags: string[];
  tagServiceKey?: string;
  /** changed = были ли применены изменения (→ родитель перезапустит поиск) */
  onClose: (changed: boolean) => void;
}

interface Pair {
  a: FileMetadata;
  b: FileMetadata;
  decision: Decision;
}

type Mode = "auto" | "filter";

/** pixel_duplicates enum + человеческие подписи. */
const PIXEL_MODES: [number, string][] = [
  [2, "Near-dupes (not pixel-identical)"],
  [1, "Any similar"],
  [0, "Pixel-identical only"],
];

const PAIR_BATCH = 100;

export function Duplicates(props: Props) {
  const [distance, setDistance] = createSignal(8);
  const [pixelMode, setPixelMode] = createSignal(2);
  const [mode, setMode] = createSignal<Mode>("auto");
  let changed = false;

  const query = createMemo(() => ({
    tags: props.tags,
    tagServiceKey: props.tagServiceKey,
    pixelDuplicates: pixelMode(),
    maxHammingDistance: distance(),
  }));

  const [count, { refetch: refetchCount }] = createResource(query, (q) => props.api.potentialsCount(q));

  const [pairs, { refetch: refetchPairs }] = createResource(query, async (q): Promise<Pair[]> => {
    const raw = await props.api.potentialPairs({ ...q, maxNumPairs: PAIR_BATCH, sortType: 0 });
    if (!raw.length) return [];
    const hashes = [...new Set(raw.flat())];
    const metas = await props.api.metadataByHash(hashes);
    const byHash = new Map(metas.map((m) => [m.hash, m]));
    const pixelIdentical = q.pixelDuplicates === 0;
    const out: Pair[] = [];
    for (const [ha, hb] of raw) {
      const a = byHash.get(ha);
      const b = byHash.get(hb);
      if (a && b) out.push({ a, b, decision: decide(a, b, pixelIdentical) });
    }
    return out;
  });

  function reload() {
    void refetchCount();
    void refetchPairs();
  }

  /** Применить решения (фон), пометить changed, дать undo на удалённые файлы. */
  async function applyDecision(rels: RelationshipSet[], undeleteIds?: number[]) {
    changed = true;
    try {
      await props.api.setFileRelationships(rels);
      const n = undeleteIds?.length ?? 0;
      if (n) {
        pushToast(`Trashed ${n} worse duplicate${n > 1 ? "s" : ""}`, {
          onUndo: () => void props.api.undeleteFiles(undeleteIds!).catch((e) => pushToast(String(e), { kind: "error" })),
        });
      }
      void refetchCount();
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  return (
    <div class="overlay" onClick={() => props.onClose(changed)}>
      <div class="dupes" onClick={(e) => e.stopPropagation()}>
        <div class="toolbar">
          <strong>Duplicates</strong>
          <span class="counter">
            <Show when={!count.loading} fallback="counting…">
              <Show when={!count.error} fallback="count failed — check 'Manage File Relationships' permission">
                {count()} potential pairs
              </Show>
            </Show>
          </span>
          <span class="spacer" />
          <button class="ctl" classList={{ on: mode() === "auto" }} onClick={() => setMode("auto")}>Auto</button>
          <button class="ctl" classList={{ on: mode() === "filter" }} onClick={() => setMode("filter")}>Filter</button>
          <label class="dupes-range">
            distance
            <input
              type="range"
              min="0"
              max="16"
              value={distance()}
              onInput={(e) => setDistance(+e.currentTarget.value)}
            />
            <span class="counter">{distance()}</span>
          </label>
          <select class="ctl" value={String(pixelMode())} onChange={(e) => setPixelMode(+e.currentTarget.value)}>
            <For each={PIXEL_MODES}>{([v, l]) => <option value={v}>{l}</option>}</For>
          </select>
          <button class="close" onClick={() => props.onClose(changed)} aria-label="Close">✕</button>
        </div>

        <Show when={!pairs.loading} fallback={<p class="loading">Loading pairs…</p>}>
          <Show when={!pairs.error} fallback={<p class="error">{String(pairs.error)}</p>}>
            <Show
              when={pairs()?.length}
              fallback={<p class="muted">No potential pairs — let Hydrus finish its duplicate search, or widen the distance.</p>}
            >
              <Show
                when={mode() === "filter"}
                fallback={<AutoResolve api={props.api} pairs={pairs()!} onApply={applyDecision} onReload={reload} />}
              >
                <ManualFilter
                  api={props.api}
                  pairs={pairs()!}
                  onApply={applyDecision}
                  onReload={reload}
                  onClose={() => props.onClose(changed)}
                />
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}

// ---- авто-резолв: предпросмотр решений comparator'а + батч ----

function AutoResolve(props: {
  api: HydrusApi;
  pairs: Pair[];
  onApply: (rels: RelationshipSet[], undeleteIds?: number[]) => Promise<void>;
  onReload: () => void;
}) {
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  const [confirming, setConfirming] = createSignal(false);

  // при смене батча — выбрать только уверенные пары
  createEffect(on(() => props.pairs, (ps) => {
    const s = new Set<number>();
    ps.forEach((p, i) => p.decision.confident && s.add(i));
    setSelected(s);
    setConfirming(false);
  }));

  function toggle(i: number) {
    const s = new Set(selected());
    s.has(i) ? s.delete(i) : s.add(i);
    setSelected(s);
    setConfirming(false);
  }

  // собрать батч со skip-logic: не слать пары, чей файл уже выбыл в этом же батче
  function buildBatch(): { rels: RelationshipSet[]; undeleteIds: number[] } {
    const consumed = new Set<string>();
    const rels: RelationshipSet[] = [];
    const undeleteIds: number[] = [];
    for (const i of [...selected()].sort((x, y) => x - y)) {
      const p = props.pairs[i];
      if (consumed.has(p.a.hash) || consumed.has(p.b.hash)) continue;
      const { winner, loser } = p.decision;
      rels.push({
        hash_a: winner.hash,
        hash_b: loser.hash,
        relationship: DUPLICATE.A_BETTER,
        do_default_content_merge: true,
        delete_b: true,
      });
      consumed.add(loser.hash);
      undeleteIds.push(loser.file_id);
    }
    return { rels, undeleteIds };
  }

  const willApply = createMemo(() => buildBatch().rels.length);

  async function apply() {
    const { rels, undeleteIds } = buildBatch();
    setConfirming(false);
    if (!rels.length) return;
    await props.onApply(rels, undeleteIds);
    props.onReload();
  }

  return (
    <>
      <div class="dupes-body">
        <For each={props.pairs}>
          {(p, i) => (
            <PairRow api={props.api} pair={p} selected={selected().has(i())} onToggle={() => toggle(i())} />
          )}
        </For>
      </div>
      <div class="dupes-foot">
        <span class="muted">{willApply()} pair(s) → trash {willApply()} worse file(s) · merge tags</span>
        <span class="spacer" />
        <Show
          when={confirming()}
          fallback={
            <button class="ctl" disabled={!willApply()} onClick={() => setConfirming(true)}>Apply…</button>
          }
        >
          <button class="ctl" onClick={() => setConfirming(false)}>Cancel</button>
          <button class="danger" onClick={apply}>Confirm — trash {willApply()}</button>
        </Show>
      </div>
    </>
  );
}

// ---- ручной фильтр: одна пара за раз, решения с клавиатуры ----

type DecisionKind = "a-better" | "b-better" | "same" | "alt" | "notdupe" | "skip";

function ManualFilter(props: {
  api: HydrusApi;
  pairs: Pair[];
  onApply: (rels: RelationshipSet[], undeleteIds?: number[]) => Promise<void>;
  onReload: () => void;
  onClose: () => void;
}) {
  const [index, setIndex] = createSignal(0);
  // хэши, выбывшие из игры в этом батче (удалённые/слитые) — их пары пропускаем (см. доку API)
  const consumed = new Set<string>();

  createEffect(on(() => props.pairs, () => {
    consumed.clear();
    setIndex(0);
  }));

  const cur = () => props.pairs[index()];
  const done = () => index() >= props.pairs.length;

  function advanceFrom(i: number) {
    let j = i;
    while (j < props.pairs.length && (consumed.has(props.pairs[j].a.hash) || consumed.has(props.pairs[j].b.hash))) j++;
    setIndex(j);
  }

  function act(kind: DecisionKind) {
    const p = cur();
    if (!p) return;
    const i = index();
    const { a, b } = p;

    let rels: RelationshipSet[] | null = null;
    let undeleteIds: number[] | undefined;
    switch (kind) {
      case "a-better":
        rels = [{ hash_a: a.hash, hash_b: b.hash, relationship: DUPLICATE.A_BETTER, do_default_content_merge: true, delete_b: true }];
        consumed.add(b.hash);
        undeleteIds = [b.file_id];
        break;
      case "b-better":
        rels = [{ hash_a: b.hash, hash_b: a.hash, relationship: DUPLICATE.A_BETTER, do_default_content_merge: true, delete_b: true }];
        consumed.add(a.hash);
        undeleteIds = [a.file_id];
        break;
      case "same":
        rels = [{ hash_a: a.hash, hash_b: b.hash, relationship: DUPLICATE.SAME_QUALITY, do_default_content_merge: true }];
        consumed.add(b.hash); // B сливается в A
        break;
      case "alt":
        rels = [{ hash_a: a.hash, hash_b: b.hash, relationship: DUPLICATE.ALTERNATE, do_default_content_merge: false }];
        break;
      case "notdupe":
        rels = [{ hash_a: a.hash, hash_b: b.hash, relationship: DUPLICATE.FALSE_POSITIVE, do_default_content_merge: false }];
        break;
      case "skip":
        break;
    }

    advanceFrom(i + 1); // оптимистичный переход, запрос летит в фоне
    if (rels) void props.onApply(rels, undeleteIds);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); props.onClose(); return; }
    if (done()) return;
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); act("a-better"); break;
      case "ArrowRight": e.preventDefault(); act("b-better"); break;
      case "=": case "s": e.preventDefault(); act("same"); break;
      case "a": e.preventDefault(); act("alt"); break;
      case "x": e.preventDefault(); act("notdupe"); break;
      case " ": e.preventDefault(); act("skip"); break;
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show
      when={!done()}
      fallback={
        <div class="filter-done">
          <p class="muted">Batch done.</p>
          <button class="ctl" onClick={props.onReload}>Load next batch</button>
        </div>
      }
    >
      {(() => {
        const p = cur()!;
        const keep = (m: FileMetadata) => m.hash === p.decision.winner.hash;
        return (
          <div class="filter">
            <div class="counter">
              pair {index() + 1} / {props.pairs.length} · suggestion: keep {keep(p.a) ? "A (left)" : "B (right)"} — {p.decision.reason}
            </div>
            <div class="filter-pics">
              <FilterSide api={props.api} meta={p.a} label="A" suggested={keep(p.a)} />
              <FilterSide api={props.api} meta={p.b} label="B" suggested={keep(p.b)} />
            </div>
            <div class="filter-actions">
              <button onClick={() => act("a-better")}>◀ A better</button>
              <button onClick={() => act("same")}>= same (s)</button>
              <button onClick={() => act("alt")}>alternates (a)</button>
              <button onClick={() => act("notdupe")}>✗ not dupe (x)</button>
              <button onClick={() => act("skip")}>skip (space)</button>
              <button onClick={() => act("b-better")}>B better ▶</button>
            </div>
          </div>
        );
      })()}
    </Show>
  );
}

function FilterSide(props: { api: HydrusApi; meta: FileMetadata; label: string; suggested: boolean }) {
  const m = props.meta;
  const url = props.api.fileUrlByHash(m.hash);
  const isVid = (m.mime ?? "").startsWith("video");
  return (
    <div class="filter-side" classList={{ suggested: props.suggested }}>
      <div class="filter-cap">
        {props.label}{props.suggested ? " · suggested keep" : ""} · {mediaInfo(m)}
      </div>
      <Show
        when={isVid}
        fallback={
          <a href={url} target="_blank" rel="noreferrer" title="Open full file in new tab">
            {/* gif/apng/animated-webp анимируются как обычный <img> */}
            <img class="filter-img" src={url} alt={m.hash} draggable={false} />
          </a>
        }
      >
        <video class="filter-img" src={url} controls loop autoplay muted playsinline />
      </Show>
    </div>
  );
}

// ---- строка пары (предпросмотр авто-резолва) ----

function PairRow(props: { api: HydrusApi; pair: Pair; selected: boolean; onToggle: () => void }) {
  const d = props.pair.decision;
  const roleOf = (m: FileMetadata): "keep" | "remove" => (m.hash === d.winner.hash ? "keep" : "remove");
  return (
    <div class="pair" classList={{ active: props.selected }}>
      <Side api={props.api} meta={props.pair.a} role={roleOf(props.pair.a)} />
      <div class="pair-mid">
        <label class="pair-pick">
          <input type="checkbox" checked={props.selected} onChange={props.onToggle} />
        </label>
        <div class="pair-reason">{d.reason}</div>
        <Show when={!d.confident}>
          <div class="pair-flag" title="Equal resolution — review by eye">manual</div>
        </Show>
      </div>
      <Side api={props.api} meta={props.pair.b} role={roleOf(props.pair.b)} />
    </div>
  );
}

function Side(props: { api: HydrusApi; meta: FileMetadata; role: "keep" | "remove" }) {
  const m = props.meta;
  return (
    <div class="pair-side" classList={{ keep: props.role === "keep", remove: props.role === "remove" }}>
      <div class="pair-badge">{props.role}</div>
      <img class="pair-thumb" src={props.api.thumbnailUrlByHash(m.hash)} loading="lazy" decoding="async" />
      <div class="pair-meta">{mediaInfo(m)}</div>
    </div>
  );
}
