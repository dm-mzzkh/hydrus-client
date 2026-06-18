import type { HydrusApi, TagSuggestion } from "./api/hydrus";
import { fuzzyMatch } from "./fzf";

/** "sam" → "*s*a*m*": subsequence-glob для fuzzy-выборки кандидатов с сервера. */
export function fuzzyGlob(s: string): string {
  const chars = [...s].filter((c) => c !== " ");
  return chars.length ? `*${chars.join("*")}*` : "";
}

/**
 * Запросы к Hydrus по убыванию «фаззи-ности», пробуем по очереди до первого
 * непустого ответа. Так получаем fuzzy там, где сервер тянет glob, и аккуратно
 * деградируем до префикса/raw, если нет.
 *
 * Важно: namespace передаём точным (без wildcard). Автокомплит Hydrus не ищет по
 * `creator*:*`, поэтому канонические формы — `creator:*` (весь namespace) и
 * `creator:<sub>` (внутри namespace).
 */
export function buildQueries(needle: string): string[] {
  const lower = needle.toLowerCase();
  const colon = lower.indexOf(":");
  if (colon >= 0) {
    const ns = lower.slice(0, colon).trim();
    const sub = lower.slice(colon + 1).trim();
    // ":sam" — подтег в любом namespace
    if (!ns) return sub ? [`*:${fuzzyGlob(sub)}`, `*:${sub}*`, `*:${sub}`] : [];
    // "creator:" — весь namespace (сервер отдаёт count-sorted)
    if (!sub) return [`${ns}:*`];
    // "creator:sam" — fuzzy → префикс → raw, всё в пределах namespace
    return [`${ns}:${fuzzyGlob(sub)}`, `${ns}:${sub}*`, `${ns}:${sub}`];
  }
  const compact = lower.replace(/\s/g, "");
  const queries = compact.length >= 2 ? [fuzzyGlob(lower)] : [];
  queries.push(`${lower}*`, lower);
  return queries.filter(Boolean);
}

/** Префиксы для «развёртки» неймспейса в обход блокировки pure-wildcard. */
const SWEEP = [..."abcdefghijklmnopqrstuvwxyz0123456789"];

/**
 * Все теги неймспейса ("creator:"). Hydrus на «all known tags»/PTR режет голый
 * `creator:*` как pure-wildcard и отдаёт пусто, поэтому собираем перебором
 * непустых префиксов `creator:a*`…`creator:z*` (каждый запрос проходит правила).
 * Сперва пробуем дешёвый прямой `creator:*` — вдруг сервис его разрешает.
 */
async function fetchNamespaceAll(api: HydrusApi, ns: string, tagServiceKey?: string): Promise<TagSuggestion[]> {
  try {
    const direct = await api.searchTags(`${ns}:*`, tagServiceKey);
    if (direct.length) return direct;
  } catch {
    /* заблокировано правилами сервиса — идём перебором */
  }
  const batches = await Promise.all(
    SWEEP.map((c) => api.searchTags(`${ns}:${c}*`, tagServiceKey).catch(() => [] as TagSuggestion[])),
  );
  // подтег матчится ровно одним префиксом (по первому символу) → дублей нет
  return batches.flat().sort((a, b) => b.count - a.count);
}

export async function fetchCandidates(api: HydrusApi, needle: string, tagServiceKey?: string) {
  // "creator:" (только namespace) — особый путь: разворачиваем весь неймспейс
  const colon = needle.indexOf(":");
  if (colon > 0 && !needle.slice(colon + 1).trim()) {
    const ns = needle.slice(0, colon).trim().toLowerCase();
    if (ns) return (await fetchNamespaceAll(api, ns, tagServiceKey)).slice(0, 200);
  }
  for (const q of buildQueries(needle)) {
    try {
      const tags = await api.searchTags(q, tagServiceKey);
      if (tags.length) return tags.slice(0, 200); // count-sorted: берём популярные кандидаты
    } catch {
      /* пробуем следующий, менее агрессивный запрос */
    }
  }
  return [];
}

export interface RankedTag {
  value: string;
  count: number;
  positions: number[]; // позиции подсветки в value
}

/**
 * Отранжировать кандидатов под текущий ввод тем же fuzzy, что и подсветка.
 * Для «namespace:» (пустой подтег) фаззить нечего — отдаём по популярности.
 */
export function rankCandidates(needle: string, candidates: TagSuggestion[], limit = 15): RankedTag[] {
  const colon = needle.indexOf(":");
  if (colon >= 0 && !needle.slice(colon + 1).trim()) {
    return [...candidates]
      .sort((a, b) => b.count - a.count)
      .slice(0, limit)
      .map((t) => ({ value: t.value, count: t.count, positions: [] }));
  }
  return candidates
    .map((t) => ({ t, m: fuzzyMatch(needle, t.value) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m!.score - a.m!.score || b.t.count - a.t.count)
    .slice(0, limit)
    .map(({ t, m }) => ({ value: t.value, count: t.count, positions: m!.positions }));
}
