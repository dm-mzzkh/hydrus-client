import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { fuzzyMatch } from "../fzf";
import { fetchCandidates } from "../tagsuggest";
import { TagLabel } from "./TagLabel";

interface Scored {
  value: string;
  count: number;
  positions: number[];
}

/** Поле ввода одного тега с тем же fuzzy-автокомплитом, что и в поиске. */
export function TagInput(props: {
  api: HydrusApi;
  tagServiceKey?: string;
  placeholder?: string;
  onPick: (tag: string) => void;
}) {
  let inputEl!: HTMLInputElement;
  let listEl: HTMLUListElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const [text, setText] = createSignal("");
  const [needle, setNeedle] = createSignal("");
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(-1);

  const [results] = createResource(
    () => (open() ? needle() : ""),
    async (q): Promise<Scored[]> => {
      const n = q.trim();
      if (!n) return [];
      const cands = await fetchCandidates(props.api, n, props.tagServiceKey);
      return cands
        .map((t) => ({ t, m: fuzzyMatch(n, t.value) }))
        .filter((x) => x.m)
        .sort((a, b) => b.m!.score - a.m!.score || b.t.count - a.t.count)
        .slice(0, 15)
        .map(({ t, m }) => ({ value: t.value, count: t.count, positions: m!.positions }));
    },
  );
  const list = () => results() ?? [];
  const visible = () => open() && list().length > 0;

  createEffect(() => {
    const i = active();
    if (i < 0 || !listEl) return;
    (listEl.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  });

  function pick(tag: string) {
    const t = tag.trim();
    if (!t) return;
    props.onPick(t);
    setText("");
    setNeedle("");
    setOpen(false);
    setActive(-1);
    inputEl.focus();
  }

  function onInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value;
    setText(v);
    setActive(-1);
    setOpen(true);
    clearTimeout(timer);
    timer = setTimeout(() => setNeedle(v), 120);
  }

  function onKeyDown(e: KeyboardEvent) {
    const items = list();
    switch (e.key) {
      case "ArrowDown":
        if (visible()) {
          e.preventDefault();
          setActive((i) => Math.min(i + 1, items.length - 1));
        }
        break;
      case "ArrowUp":
        if (visible()) {
          e.preventDefault();
          setActive((i) => Math.max(i - 1, -1));
        }
        break;
      case "Tab":
        if (visible()) {
          e.preventDefault();
          pick(items[active() >= 0 ? active() : 0].value);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (visible() && active() >= 0) pick(items[active()].value);
        else pick(text()); // добавить введённое как есть
        break;
      case "Escape":
        setOpen(false);
        break;
    }
  }

  return (
    <div class="tag-input">
      <input
        ref={inputEl}
        class="add-tag"
        placeholder={props.placeholder}
        value={text()}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        autocomplete="off"
        spellcheck={false}
      />
      <Show when={visible()}>
        <ul class="suggest" ref={listEl}>
          <For each={list()}>
            {(s, i) => (
              <li
                class="suggest-item"
                classList={{ active: i() === active() }}
                onMouseEnter={() => setActive(i())}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s.value);
                }}
              >
                <TagLabel value={s.value} positions={s.positions} />
                <span class="suggest-count">{s.count.toLocaleString()}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
