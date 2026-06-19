import { createResource, createSignal, Show } from "solid-js";
import { DUPLICATE, type HydrusApi, type RelationshipSet } from "../api/hydrus";
import { decide, dims, ext } from "../dupes";
import { pushToast } from "../toast";
import { onEscape } from "../util";

/**
 * Назначить отношения дублей всему выделению (≥2 файла). Группирующие связи
 * (alternate / same-quality) ставятся звездой от первого файла — Hydrus группирует их
 * транзитивно. «Keep best» выбирает короля компаратором decide() и помечает остальных
 * худшими (A_BETTER) с мерджем метаданных и удалением в корзину. Связи необратимы.
 */
export function RelationshipsModal(props: {
  api: HydrusApi;
  ids: number[];
  onClose: (changed?: boolean) => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [data] = createResource(() => props.api.fileMetadataMany(props.ids));
  onEscape(() => props.onClose());
  const metas = () => data() ?? [];
  const king = () => {
    const ms = metas();
    return ms.length >= 2 ? ms.reduce((a, b) => decide(a, b, false).winner) : null;
  };

  async function setRel(
    label: string,
    relationship: number,
    opts: { merge: boolean; keepBest?: boolean },
  ) {
    const ms = metas();
    if (ms.length < 2 || busy()) return;
    setBusy(true);
    try {
      let rels: RelationshipSet[];
      if (opts.keepBest) {
        const k = king()!;
        rels = ms
          .filter((m) => m.hash !== k.hash)
          .map((m) => ({
            hash_a: k.hash,
            hash_b: m.hash,
            relationship,
            do_default_content_merge: opts.merge,
            delete_b: true,
          }));
      } else {
        const anchor = ms[0];
        rels = ms
          .slice(1)
          .map((m) => ({
            hash_a: anchor.hash,
            hash_b: m.hash,
            relationship,
            do_default_content_merge: opts.merge,
          }));
      }
      await props.api.setFileRelationships(rels);
      pushToast(`${label} (${ms.length})`);
      props.onClose(!!opts.keepBest);
    } catch (e) {
      pushToast(String(e), { kind: "error" });
      setBusy(false);
    }
  }

  return (
    <div class="overlay" onClick={() => props.onClose()}>
      <div class="confirm rel-modal" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-title">Set relationship · {props.ids.length} files</div>
        <Show when={!data.loading} fallback={<div class="loading">Loading…</div>}>
          <div class="confirm-msg">Not reversible. Grouping links anchor on the first selected file.</div>
          <div class="rel-actions">
            <button disabled={busy()} onClick={() => void setRel("Set as alternates", DUPLICATE.ALTERNATE, { merge: false })}>
              Alternates
            </button>
            <button disabled={busy()} onClick={() => void setRel("Set as duplicates", DUPLICATE.SAME_QUALITY, { merge: true })}>
              Duplicates · same quality
            </button>
            <button disabled={busy()} onClick={() => void setRel("Marked not duplicates", DUPLICATE.FALSE_POSITIVE, { merge: false })}>
              Not duplicates (false positive)
            </button>
            <Show when={king()}>
              {(k) => (
                <button
                  class="danger"
                  disabled={busy()}
                  onClick={() => void setRel("Deduplicated", DUPLICATE.A_BETTER, { merge: true, keepBest: true })}
                >
                  Duplicates · keep best, trash {metas().length - 1}
                  <span class="rel-king"> — keeps {dims(k())} {ext(k())}</span>
                </button>
              )}
            </Show>
          </div>
        </Show>
        <div class="confirm-actions">
          <button onClick={() => props.onClose()}>Close</button>
        </div>
      </div>
    </div>
  );
}
