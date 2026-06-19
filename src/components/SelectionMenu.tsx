import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { HydrusApi, ServiceInfo } from "../api/hydrus";
import { TagInput } from "./TagInput";
import { onEscape } from "../util";

/**
 * Действия над выделенными файлами. Объект стабилен (методы — замыкания над текущим
 * выделением, читают его в момент вызова), поэтому его можно создать один раз в App.
 * `services`/`count`/`api` пробрасываются отдельными реактивными пропсами, не сюда.
 */
export interface SelectionActions {
  archive(): void;
  inbox(): void;
  trash(): void;
  addTag(tag: string): void;
  openRemoveTags(): void;
  rate(serviceKey: string, type: number, value: boolean | number | null): void;
  associateUrls(): void;
  setNote(): void;
  setRelationships(): void;
  restoreFromTrash(): void;
  deletePermanently(): void;
  copyHashes(): void;
  copyUrls(): void;
  exportZip(): void;
  selectAll(): void;
  invert(): void;
  clear(): void;
}

/** Список действий — общий для дропдауна «More» и контекстного меню. */
function MenuBody(props: {
  a: SelectionActions;
  api: HydrusApi;
  tagServiceKey?: string;
  inTrash?: boolean;
  multi?: boolean;
  services?: Record<string, ServiceInfo>;
  close: () => void;
}) {
  const [open, setOpen] = createSignal<"add" | "rate" | null>(null);
  const a = () => props.a;
  const run = (fn: () => void) => { fn(); props.close(); };

  const ratingServices = () =>
    Object.values(props.services ?? {}).filter((s) => s.type === 6 || s.type === 7 || s.type === 22);

  return (
    <div class="sel-menu" onClick={(e) => e.stopPropagation()}>
      <button class="sel-item" onClick={() => run(a().archive)}>Archive</button>
      <button class="sel-item" onClick={() => run(a().inbox)}>Move to inbox</button>
      <Show
        when={props.inTrash}
        fallback={<button class="sel-item danger" onClick={() => run(a().trash)}>Trash</button>}
      >
        <button class="sel-item" onClick={() => run(a().restoreFromTrash)}>Untrash</button>
      </Show>
      <div class="sel-sep" />

      <button class="sel-item" onClick={() => setOpen(open() === "add" ? null : "add")}>Add tag…</button>
      <Show when={open() === "add"}>
        <div class="sel-taginput">
          <TagInput
            api={props.api}
            tagServiceKey={props.tagServiceKey}
            placeholder="add tag…"
            onPick={(t) => { a().addTag(t); props.close(); }}
          />
        </div>
      </Show>

      <button class="sel-item" onClick={() => run(a().openRemoveTags)}>Remove tag…</button>

      <Show when={ratingServices().length}>
        <button class="sel-item" onClick={() => setOpen(open() === "rate" ? null : "rate")}>Set rating…</button>
        <Show when={open() === "rate"}>
          <div class="sel-ratings">
            <For each={ratingServices()}>
              {(s) => {
                const set = (v: boolean | number | null) => run(() => a().rate(s.service_key, s.type, v));
                return (
                  <div class="sel-rating">
                    <span class="sel-rating-name">{s.name}</span>
                    <span class="sel-rating-ctl">
                      <Switch>
                        <Match when={s.type === 7}>
                          <button onClick={() => set(true)}>♥</button>
                          <button onClick={() => set(false)}>✗</button>
                          <button title="clear" onClick={() => set(null)}>∅</button>
                        </Match>
                        <Match when={s.type === 6}>
                          <For each={Array.from({ length: s.max_stars ?? 5 }, (_, i) => i + 1)}>
                            {(i) => <button class="star" onClick={() => set(i)}>★</button>}
                          </For>
                          <button title="clear" onClick={() => set(null)}>∅</button>
                        </Match>
                        <Match when={s.type === 22}>
                          <IncDec onSet={(v) => set(v)} />
                        </Match>
                      </Switch>
                    </span>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <div class="sel-sep" />

      <button class="sel-item" onClick={() => run(a().associateUrls)}>Associate URL…</button>
      <button class="sel-item" onClick={() => run(a().setNote)}>Set note…</button>
      <Show when={props.multi}>
        <button class="sel-item" onClick={() => run(a().setRelationships)}>Set relationship…</button>
      </Show>
      <div class="sel-sep" />

      <button class="sel-item" onClick={() => run(a().copyHashes)}>Copy hashes</button>
      <button class="sel-item" onClick={() => run(a().copyUrls)}>Copy file URLs</button>
      <button class="sel-item" onClick={() => run(a().exportZip)}>Export as ZIP</button>
      <div class="sel-sep" />

      <Show when={props.inTrash}>
        <button class="sel-item danger" onClick={() => run(a().deletePermanently)}>Delete permanently…</button>
        <div class="sel-sep" />
      </Show>

      <button class="sel-item" onClick={() => run(a().selectAll)}>Select all</button>
      <button class="sel-item" onClick={() => run(a().invert)}>Invert selection</button>
      <button class="sel-item" onClick={() => run(a().clear)}>Clear selection</button>
    </div>
  );
}

/** Установка абсолютного значения inc/dec рейтинга для всего выделения. */
function IncDec(props: { onSet: (v: number) => void }) {
  const [v, setV] = createSignal(0);
  return (
    <>
      <button onClick={() => setV((x) => Math.max(0, x - 1))}>−</button>
      <span class="incdec">{v()}</span>
      <button onClick={() => setV((x) => x + 1)}>+</button>
      <button onClick={() => props.onSet(v())}>set</button>
    </>
  );
}

/** Верхний бар выделения: счётчик + горячие действия + «More ▾» + select all/invert/clear. */
export function SelectionBar(props: {
  count: number;
  api: HydrusApi;
  tagServiceKey?: string;
  inTrash?: boolean;
  multi?: boolean;
  services?: Record<string, ServiceInfo>;
  a: SelectionActions;
}) {
  const [moreOpen, setMoreOpen] = createSignal(false);
  return (
    <div class="batchbar">
      <span>{props.count} selected</span>
      <button onClick={() => props.a.archive()}>Archive</button>
      <button onClick={() => props.a.inbox()}>Inbox</button>
      <Show when={props.inTrash} fallback={<button onClick={() => props.a.trash()}>Trash</button>}>
        <button onClick={() => props.a.restoreFromTrash()}>Untrash</button>
      </Show>
      <div class="sel-taginput batchbar-tag">
        <TagInput
          api={props.api}
          tagServiceKey={props.tagServiceKey}
          placeholder="add tag…"
          onPick={(t) => props.a.addTag(t)}
        />
      </div>
      <div class="sel-more">
        <button onClick={() => setMoreOpen((o) => !o)}>More ▾</button>
        <Show when={moreOpen()}>
          <div class="backdrop" onClick={() => setMoreOpen(false)} />
          <div class="sel-dropdown">
            <MenuBody
              a={props.a}
              api={props.api}
              tagServiceKey={props.tagServiceKey}
              inTrash={props.inTrash}
              multi={props.multi}
              services={props.services}
              close={() => setMoreOpen(false)}
            />
          </div>
        </Show>
      </div>
      <button class="spacer" onClick={() => props.a.selectAll()}>All</button>
      <button onClick={() => props.a.invert()}>Invert</button>
      <button onClick={() => props.a.clear()}>Clear</button>
    </div>
  );
}

/** Плавающее контекстное меню по правому клику на миниатюре. */
export function ContextMenu(props: {
  x: number;
  y: number;
  api: HydrusApi;
  tagServiceKey?: string;
  inTrash?: boolean;
  multi?: boolean;
  services?: Record<string, ServiceInfo>;
  a: SelectionActions;
  onClose: () => void;
}) {
  onEscape(() => props.onClose());
  // примитивный клэмп, чтобы меню не уезжало за правый/нижний край вьюпорта
  const left = () => Math.max(4, Math.min(props.x, window.innerWidth - 240));
  const top = () => Math.max(4, Math.min(props.y, window.innerHeight - 380));
  return (
    <>
      <div
        class="backdrop"
        onClick={props.onClose}
        onContextMenu={(e) => { e.preventDefault(); props.onClose(); }}
      />
      <div class="sel-context" style={{ left: `${left()}px`, top: `${top()}px` }}>
        <MenuBody
          a={props.a}
          api={props.api}
          tagServiceKey={props.tagServiceKey}
          inTrash={props.inTrash}
          multi={props.multi}
          services={props.services}
          close={props.onClose}
        />
      </div>
    </>
  );
}
