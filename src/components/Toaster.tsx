import { For, Show } from "solid-js";
import { dismissToast, toasts } from "../toast";

export function Toaster() {
  return (
    <div class="toaster">
      <For each={toasts()}>
        {(t) => (
          <div class="toast" classList={{ error: t.kind === "error" }}>
            <span class="toast-msg">{t.message}</span>
            <Show when={t.onUndo}>
              <button
                class="toast-undo"
                onClick={() => {
                  t.onUndo!();
                  dismissToast(t.id);
                }}
              >
                Undo
              </button>
            </Show>
            <button class="toast-x" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
