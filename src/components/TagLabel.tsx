import { createMemo, For } from "solid-js";

/** Цвета частых namespace, как в Hydrus. Неизвестные — стабильный цвет по хешу. */
const NS_COLORS: Record<string, string> = {
  creator: "#e0556b",
  series: "#c879e6",
  character: "#5fd17a",
  studio: "#e8a13a",
  person: "#4fd0c0",
  title: "#5aa9f0",
  medium: "#b0a0ff",
  meta: "#9aa3ad",
};

export function namespaceColor(ns: string): string {
  const known = NS_COLORS[ns];
  if (known) return known;
  let h = 0;
  for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 65%)`;
}

interface Seg {
  text: string;
  ns: boolean; // часть namespace (включая ":")
  match: boolean; // совпавший при fuzzy символ
}

function buildSegments(value: string, positions?: number[]) {
  const colon = value.indexOf(":");
  const nsName = colon > 0 ? value.slice(0, colon) : null;
  const matched = new Set(positions ?? []);
  const segs: Seg[] = [];
  for (let i = 0; i < value.length; i++) {
    const ns = colon > 0 && i <= colon;
    const match = matched.has(i);
    const last = segs[segs.length - 1];
    if (last && last.ns === ns && last.match === match) last.text += value[i];
    else segs.push({ text: value[i], ns, match });
  }
  return { segs, nsName };
}

/** Тег с цветным namespace и (опционально) подсветкой совпавших при fuzzy символов. */
export function TagLabel(props: { value: string; positions?: number[] }) {
  const built = createMemo(() => buildSegments(props.value, props.positions));
  return (
    <span class="tag-label">
      <For each={built().segs}>
        {(seg) => (
          <span
            classList={{ "tag-ns": seg.ns, match: seg.match }}
            style={seg.ns ? { "--ns-color": namespaceColor(built().nsName ?? "") } : undefined}
          >
            {seg.text}
          </span>
        )}
      </For>
    </span>
  );
}
