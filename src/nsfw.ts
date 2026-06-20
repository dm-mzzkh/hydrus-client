import { createSignal } from "solid-js";

// Глобальный реактивный синглтон фильтра NSFW — читается из любого компонента,
// по образцу prefs.ts/theme.ts. Три режима: «среднее» (всё), «без nsfw», «только nsfw».
export type NsfwMode = "all" | "sfw" | "nsfw";

const MODE_KEY = "hydrus-client-nsfw-mode";
const TAGS_KEY = "hydrus-client-nsfw-tags";

// Какие теги считаются NSFW (настраиваемо). Дефолт — booru-рейтинги + «nsfw».
const DEFAULT_TAGS = ["nsfw", "rating:questionable", "rating:explicit"];

function loadMode(): NsfwMode {
  const v = localStorage.getItem(MODE_KEY);
  return v === "sfw" || v === "nsfw" ? v : "all";
}

function loadTags(): string[] {
  const raw = localStorage.getItem(TAGS_KEY);
  if (raw) {
    try {
      const a = JSON.parse(raw);
      if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string")) return a;
    } catch {
      /* битые данные — упадём в дефолт */
    }
  }
  return DEFAULT_TAGS;
}

const [nsfwMode, setNsfwMode] = createSignal<NsfwMode>(loadMode());
const [nsfwTags, setNsfwTagsSig] = createSignal<string[]>(loadTags());

export { nsfwMode, nsfwTags };

// порядок переключения по клику: среднее → без nsfw → только nsfw → …
const ORDER: NsfwMode[] = ["all", "sfw", "nsfw"];

export function cycleNsfw(): void {
  const next = ORDER[(ORDER.indexOf(nsfwMode()) + 1) % ORDER.length];
  setNsfwMode(next);
  localStorage.setItem(MODE_KEY, next);
}

/** Переписать набор NSFW-тегов (пустой ввод → возврат к дефолту). */
export function setNsfwTags(tags: string[]): void {
  const clean = tags.map((t) => t.trim()).filter(Boolean);
  const list = clean.length ? clean : DEFAULT_TAGS;
  setNsfwTagsSig(list);
  localStorage.setItem(TAGS_KEY, JSON.stringify(list));
}

/**
 * Предикаты поиска для текущего режима (добавляются к запросу в runSearch).
 * Пусто = без фильтра. «без nsfw» = ни одного NSFW-тега (AND отрицаний);
 * «только nsfw» = хотя бы один NSFW-тег (OR — вложенный список для Client API).
 */
export function nsfwPredicates(): (string | string[])[] {
  const tags = nsfwTags();
  const mode = nsfwMode();
  if (mode === "sfw") return tags.map((t) => `-${t}`);
  if (mode === "nsfw") return [tags.length === 1 ? tags[0] : tags];
  return [];
}
