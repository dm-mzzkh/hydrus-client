export interface FzfResult {
  score: number;
  /** индексы совпавших символов в haystack (для подсветки) */
  positions: number[];
}

const BONUS_CONSECUTIVE = 8; // буквы идут подряд
const BONUS_START = 12; // совпадение в самом начале
const BONUS_NS = 10; // сразу после "namespace:"
const BONUS_BOUNDARY = 9; // начало слова (после пробела/_/-/( и т.п.)
const PENALTY_GAP = 1; // за каждый пропущенный символ между совпадениями
const PENALTY_LEADING = 0.5; // за позицию первого совпадения (раньше = лучше)

function isBoundary(ch: string | undefined): boolean {
  return ch === " " || ch === "_" || ch === "-" || ch === "(" || ch === "/" || ch === ".";
}

/**
 * fzf-подобный fuzzy-матч: needle должен входить в haystack как подпоследовательность.
 * Возвращает score и позиции совпавших символов, либо null если не совпало.
 * Жадный проход слева направо — не оптимум по DP, но быстрый и достаточный.
 */
export function fuzzyMatch(needleRaw: string, haystackRaw: string): FzfResult | null {
  const needle = needleRaw.toLowerCase().replace(/\s+/g, "");
  const hay = haystackRaw.toLowerCase();
  if (!needle) return { score: 0, positions: [] };

  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  let prev = -2;

  for (const c of needle) {
    let found = -1;
    for (let k = cursor; k < hay.length; k++) {
      if (hay[k] === c) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;

    positions.push(found);
    if (found === prev + 1) {
      score += BONUS_CONSECUTIVE;
    } else {
      score -= (found - cursor) * PENALTY_GAP;
      const before = hay[found - 1];
      if (found === 0) score += BONUS_START;
      else if (before === ":") score += BONUS_NS;
      else if (isBoundary(before)) score += BONUS_BOUNDARY;
    }
    prev = found;
    cursor = found + 1;
  }

  score -= positions[0] * PENALTY_LEADING;
  score -= (hay.length - needle.length) * 0.1; // чуть предпочитаем более короткие теги
  return { score, positions };
}
