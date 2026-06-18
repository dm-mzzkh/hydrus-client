import { createSignal } from "solid-js";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
  onUndo?: () => void;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let seq = 1;

export { toasts };

export function dismissToast(id: number): void {
  setToasts((t) => t.filter((x) => x.id !== id));
}

export function pushToast(
  message: string,
  opts: { kind?: "info" | "error"; onUndo?: () => void; duration?: number } = {},
): number {
  const id = seq++;
  setToasts((t) => [...t, { id, message, kind: opts.kind ?? "info", onUndo: opts.onUndo }]);
  const dur = opts.duration ?? (opts.onUndo ? 6000 : 3000);
  setTimeout(() => dismissToast(id), dur);
  return id;
}
