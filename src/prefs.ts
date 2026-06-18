import { createSignal } from "solid-js";

const KEY = "hydrus-client-muted";

// глобальный реактивный сигнал — читается из любого компонента
const [muted, setMuted] = createSignal(localStorage.getItem(KEY) === "1");

export { muted };

export function toggleMuted(): void {
  const v = !muted();
  setMuted(v);
  localStorage.setItem(KEY, v ? "1" : "0");
}
