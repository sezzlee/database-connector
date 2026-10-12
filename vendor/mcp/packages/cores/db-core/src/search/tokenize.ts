import { fold } from "@sezzlee/mcp-core";

const separator = /[^\p{L}\p{N}]+/u;
const acronym = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;
const camel = /(\p{Ll}|\p{N})(\p{Lu})/gu;
const alphaDigit = /(\p{L})(\p{N})/gu;
const digitAlpha = /(\p{N})(\p{L})/gu;

const maxTokens = 256;
const mark = "\u0000";

function parts(chunk: string): readonly string[] {
  return chunk
    .replace(acronym, `$1${mark}$2`)
    .replace(camel, `$1${mark}$2`)
    .replace(alphaDigit, `$1${mark}$2`)
    .replace(digitAlpha, `$1${mark}$2`)
    .split(mark);
}

/**
 * Splits an identifier or a sentence into the terms an index is built from.
 *
 * Guard: the undivided chunk survives next to its parts. `CREATEDBY` carries no
 * boundary to split on while `CreatedBy` does, so an index built from the parts
 * alone files one concept under different terms depending on how the schema was
 * named — and the two never meet again. Case folding runs last for the same
 * reason: it erases the boundary the split depends on.
 */
export function tokenize(text: string): readonly string[] {
  const seen = new Set<string>();
  for (const chunk of text.split(separator)) {
    if (chunk.length === 0) {
      continue;
    }
    const pieces = parts(chunk);
    for (const piece of pieces.length > 1 ? [chunk, ...pieces] : [chunk]) {
      const term = fold(piece);
      if (term.length > 0 && !seen.has(term)) {
        seen.add(term);
        if (seen.size >= maxTokens) {
          return [...seen];
        }
      }
    }
  }
  return [...seen];
}
