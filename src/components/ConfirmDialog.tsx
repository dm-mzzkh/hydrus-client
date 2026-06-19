import { Show } from "solid-js";
import { onEscape } from "../util";

/** Простое модальное подтверждение для необратимых действий. */
export function ConfirmDialog(props: {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  onEscape(() => props.onClose());
  return (
    <div class="overlay" onClick={props.onClose}>
      <div class="confirm" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-title">{props.title}</div>
        <Show when={props.message}>
          <div class="confirm-msg">{props.message}</div>
        </Show>
        <div class="confirm-actions">
          <button autofocus onClick={props.onClose}>Cancel</button>
          <button classList={{ danger: props.danger }} onClick={() => { props.onConfirm(); props.onClose(); }}>
            {props.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
