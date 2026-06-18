import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import type { HydrusApi } from "../api/hydrus";
import { fuzzyMatch } from "../fzf";
import { fetchCandidates, rankCandidates } from "../tagsuggest";
import { TagLabel } from "./TagLabel";

interface Props {
  api: HydrusApi;
  busy: boolean;
  onSubmit: (tags: string[]) => void;
  /** скоуп автокомплита по тег-сервису (домену) */
  tagServiceKey?: string;
  /** текст поиска управляется снаружи (для «клик по тегу → поиск») */
  query: string;
  onQueryChange: (s: string) => void;
}

interface Suggestion {
  value: string; // что вставить
  positions: number[]; // позиции подсветки в value
  count?: number; // число файлов (только для тегов)
  system?: boolean; // system:-предикат
  template?: boolean; // нужно дописать значение → не добавляем ", "
}

/** Частые system:-предикаты. template = есть значение, которое надо подправить. */
const SYSTEM_PREDICATES: { value: string; template?: boolean }[] = [
  { value: "system:inbox" },
  { value: "system:archive" },
  { value: "system:everything" },
  { value: "system:has audio" },
  { value: "system:no audio" },
  { value: "system:has duration" },
  { value: "system:has tags" },
  { value: "system:no tags" },
  { value: "system:limit is 256", template: true },
  { value: "system:filetype is image", template: true },
  { value: "system:filesize < 200 KB", template: true },
  { value: "system:width = 1920", template: true },
  { value: "system:height = 1080", template: true },
  { value: "system:num tags > 5", template: true },
  { value: "system:num pixels > 1 megapixels", template: true },
  { value: "system:duration > 10 seconds", template: true },
  { value: "system:ratio = 16:9", template: true },
  { value: "system:import time < 7 days", template: true },
];

/** Границы текущего тега — сегмента вокруг каретки между запятыми. */
function currentToken(text: string, caret: number) {
  const start = text.lastIndexOf(",", caret - 1) + 1;
  let end = text.indexOf(",", caret);
  if (end === -1) end = text.length;
  return { start, end, value: text.slice(start, end).trim() };
}


/** system:-предикаты — фаззи-фильтр локального списка. */
function systemSuggestions(token: string): Suggestion[] {
  return SYSTEM_PREDICATES.map((p) => ({ p, m: fuzzyMatch(token, p.value) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .slice(0, 15)
    .map(({ p, m }) => ({ value: p.value, positions: m!.positions, system: true, template: p.template }));
}

export function SearchBar(props: Props) {
  let inputEl!: HTMLInputElement;
  let listEl: HTMLUListElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const [needle, setNeedle] = createSignal(""); // дебаунснутый текущий тег
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(-1);

  const [results] = createResource(
    () => (open() ? needle() : ""),
    async (q): Promise<Suggestion[]> => {
      const token = q.trim();
      if (!token) return [];

      if (token.toLowerCase().startsWith("system")) return systemSuggestions(token);

      // негатив: ищем по «голому» тегу, минус допишем при вставке
      const bare = token.startsWith("-") ? token.slice(1).trim() : token;
      if (!bare) return [];

      const candidates = await fetchCandidates(props.api, bare, props.tagServiceKey);
      return rankCandidates(bare, candidates);
    },
  );

  const list = () => results() ?? [];
  const visible = () => open() && list().length > 0;

  // держим подсвеченный пункт в зоне видимости при навигации стрелками
  createEffect(() => {
    const i = active();
    if (i < 0 || !listEl) return;
    (listEl.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  });

  function onInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    props.onQueryChange(el.value);
    setActive(-1);
    setOpen(true);
    const tok = currentToken(el.value, el.selectionStart ?? el.value.length);
    clearTimeout(timer);
    timer = setTimeout(() => setNeedle(tok.value), 120);
  }

  function accept(s: Suggestion) {
    const caret = inputEl.selectionStart ?? props.query.length;
    const tok = currentToken(props.query, caret);
    const before = props.query.slice(0, tok.start);
    const after = props.query.slice(tok.end);
    // негатив переносим на вставляемый тег (system:-предикаты не негативим)
    const insert = (!s.system && tok.value.startsWith("-") ? "-" : "") + s.value;

    let newText: string;
    let newCaret: number;
    if (s.template || after.trim() !== "") {
      // шаблон (нужно подправить значение) или правка в середине — без ", "
      newText = `${before}${insert}${after}`;
      newCaret = before.length + insert.length;
    } else {
      const head = before.replace(/[\s,]*$/, "");
      newText = head ? `${head}, ${insert}, ` : `${insert}, `;
      newCaret = newText.length;
    }

    props.onQueryChange(newText);
    setOpen(false);
    setActive(-1);
    queueMicrotask(() => {
      inputEl.focus();
      inputEl.setSelectionRange(newCaret, newCaret);
    });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!visible()) return;
    const items = list();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, items.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, -1));
        break;
      case "Tab":
        e.preventDefault();
        accept(items[active() >= 0 ? active() : 0]);
        break;
      case "Enter":
        if (active() >= 0) {
          e.preventDefault();
          accept(items[active()]);
        }
        break; // иначе обычный submit формы → поиск
      case "Escape":
        e.preventDefault();
        setOpen(false);
        break;
    }
  }

  function submit(e: Event) {
    e.preventDefault();
    setOpen(false);
    const tags = props.query.split(",").map((t) => t.trim()).filter(Boolean);
    props.onSubmit(tags.length ? tags : ["system:everything"]);
  }

  return (
    <div class="search-box">
      <form onSubmit={submit}>
        <input
          ref={inputEl}
          placeholder="" //should be clean
          value={props.query}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          autocomplete="off"
          spellcheck={false}
        />
        <button type="submit" disabled={props.busy}>
          {props.busy ? "…" : "Search"}
        </button>
      </form>

      <Show when={visible()}>
        <ul class="suggest" ref={listEl}>
          <For each={list()}>
            {(s, i) => (
              <li
                class="suggest-item"
                classList={{ active: i() === active() }}
                onMouseEnter={() => setActive(i())}
                onMouseDown={(e) => {
                  e.preventDefault(); // не теряем фокус инпута
                  accept(s);
                }}
              >
                <TagLabel value={s.value} positions={s.positions} />
                <Show when={s.count !== undefined} fallback={<span class="suggest-sys">system</span>}>
                  <span class="suggest-count">{s.count!.toLocaleString()}</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
