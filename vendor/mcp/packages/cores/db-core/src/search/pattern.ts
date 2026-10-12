import { fold } from "@sezzlee/mcp-core";

/**
 * Matches a name against an agent-supplied pattern, where `%` stands for any
 * run of characters and `_` for exactly one.
 *
 * Guard: bounded dynamic programming, never a constructed RegExp — the pattern
 * is agent input and a translated one backtracks catastrophically on `%a%a%a…`.
 * The same reason [file-core listing.ts](../../../file-core/src/listing.ts)
 * matches globs this way. Both sides are folded, so a pattern typed without
 * diacritics still finds the name that carries them.
 */
export function likeMatches(pattern: string, value: string): boolean {
  const target = fold(value);
  const source = fold(pattern);
  let previous = new Uint8Array(target.length + 1);
  previous[0] = 1;
  for (let p = 0; p < source.length; p += 1) {
    const next = new Uint8Array(target.length + 1);
    const token = source[p];
    if (token === "%") {
      next[0] = previous[0] ?? 0;
      for (let i = 1; i <= target.length; i += 1) {
        next[i] = previous[i] || next[i - 1] ? 1 : 0;
      }
    } else {
      for (let i = 1; i <= target.length; i += 1) {
        next[i] =
          previous[i - 1] && (token === "_" || token === target[i - 1]) ? 1 : 0;
      }
    }
    previous = next;
  }
  return previous[target.length] === 1;
}
