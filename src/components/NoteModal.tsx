import { createSignal } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { pushToast } from "../toast";
import { onEscape } from "../util";

/**
 * Установка заметки (имя + текст) на всё выделение. set_notes мёржит по имени, поэтому
 * undo просто удаляет эту заметку (если до этого под тем же именем была другая — её текст
 * не восстановится; для батча это приемлемо).
 */
export function NoteModal(props: { api: HydrusApi; ids: number[]; onClose: () => void }) {
  const [name, setName] = createSignal("note");
  const [text, setText] = createSignal("");
  onEscape(() => props.onClose());

  async function apply() {
    const nm = name().trim();
    const tx = text();
    if (!nm || !tx) return;
    const ids = props.ids;
    props.onClose();
    try {
      await props.api.setNotes(ids, { [nm]: tx });
      pushToast(`Set note "${nm}" (${ids.length})`, {
        onUndo: () =>
          void props.api.deleteNotes(ids, [nm]).catch((e) => pushToast(String(e), { kind: "error" })),
      });
    } catch (e) {
      pushToast(String(e), { kind: "error" });
    }
  }

  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="confirm note-modal" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-title">Set note on {props.ids.length} files</div>
        <input
          class="note-name"
          placeholder="note name"
          autofocus
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <textarea
          class="note-text"
          placeholder="note text · Ctrl+Enter to save"
          rows={5}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void apply(); }}
        />
        <div class="confirm-actions">
          <button onClick={props.onClose}>Cancel</button>
          <button onClick={() => void apply()}>Set note</button>
        </div>
      </div>
    </div>
  );
}
