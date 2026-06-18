import type { HydrusApi } from "./api/hydrus";

/** "sam" → "*s*a*m*": subsequence-glob для fuzzy-выборки кандидатов с сервера. */
export function fuzzyGlob(s: string): string {
  const chars = [...s].filter((c) => c !== " ");
  return chars.length ? `*${chars.join("*")}*` : "";
}

/**
 * Запросы к Hydrus по убыванию «фаззи-ности», пробуем по очереди до первого
 * непустого ответа. Так получаем fuzzy там, где сервер тянет glob, и аккуратно
 * деградируем до префикса/raw, если нет.
 */
export function buildQueries(needle: string): string[] {
  const lower = needle.toLowerCase();
  const colon = lower.indexOf(":");
  if (colon >= 0) {
    const ns = lower.slice(0, colon);
    const sub = lower.slice(colon + 1);
    return [`${ns}*:${fuzzyGlob(sub)}`, `${ns}*:${sub}*`, lower].filter((q) => q && !q.endsWith(":"));
  }
  const compact = lower.replace(/\s/g, "");
  const queries = compact.length >= 2 ? [fuzzyGlob(lower)] : [];
  queries.push(`${lower}*`, lower);
  return queries.filter(Boolean);
}

export async function fetchCandidates(api: HydrusApi, needle: string, tagServiceKey?: string) {
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
