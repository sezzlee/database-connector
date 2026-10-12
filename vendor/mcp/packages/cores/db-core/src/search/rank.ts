import { tokenize } from "./tokenize.js";
import type { InvertedIndex, Posting, SearchField } from "./inverted.js";

/**
 * Guard: starting weights, not measured ones. They say which field is the
 * stronger evidence for the same term, nothing more — a name hit outranks a
 * column hit, a column hit outranks the schema it sits in. Tuning them needs a
 * measurement against more than one deployment's naming habits.
 */
const weights: Readonly<Record<SearchField, number>> = {
  name: 3,
  description: 2,
  column: 1,
  columnDescription: 1,
  schema: 1,
};

/**
 * Guard: a prefix match is required, not a convenience. An all-capitals
 * compound carries no boundary to split on, so `FATURATARIH` yields the single
 * term `faturatarih` and only a prefix lets `fatura` reach it. The limit is
 * measured too: `tarih` does not find it, because a prefix covers the head of an
 * unsplittable compound, never its tail.
 */
const exactQuality = 1;
const prefixQuality = 0.5;

export interface MatchReason {
  readonly field: SearchField;
  readonly term: string;
  readonly value: string;
}

export interface Candidate {
  readonly document: number;
  readonly score: number;
  readonly matched: readonly MatchReason[];
}

export interface RankSpec {
  readonly maxTerms: number;
  readonly maxExpansions: number;
  readonly maxReasons: number;
}

interface Accumulator {
  score: number;
  readonly reasons: Map<string, MatchReason>;
}

/**
 * Ranks the documents a query touches, and says why each one was returned.
 *
 * Guard: a term scores once per field per document, never once per posting.
 * Repetition inside one object is how a wide table is shaped, not evidence that
 * it is the better answer — which is also why there is no `k1` or `b` here. The
 * discrimination comes from IDF alone, measured to separate `id` (0.70) from
 * `fuel` (5.33) on identifiers one to four tokens long. There is no stopword
 * list for the same reason: IDF derives one per catalogue, and a fixed list
 * would silence a word that is noise in one deployment and the deciding term in
 * another.
 */
export function rank(
  index: InvertedIndex,
  query: string,
  spec: RankSpec,
): readonly Candidate[] {
  const found = new Map<number, Accumulator>();
  const total = index.documents;

  const absorb = (
    postings: readonly Posting[],
    term: string,
    idf: number,
    quality: number,
  ): void => {
    for (const posting of postings) {
      let entry = found.get(posting.document);
      if (entry === undefined) {
        entry = { score: 0, reasons: new Map() };
        found.set(posting.document, entry);
      }
      const key = `${posting.field}\u0000${term}`;
      if (entry.reasons.has(key)) {
        continue;
      }
      entry.reasons.set(key, {
        field: posting.field,
        term,
        value: posting.value,
      });
      entry.score += idf * weights[posting.field] * quality;
    }
  };

  const idfOf = (term: string): number => {
    const frequency = index.frequency(term);
    return frequency === 0 ? 0 : Math.log(1 + total / frequency);
  };

  for (const term of tokenize(query).slice(0, spec.maxTerms)) {
    absorb(index.exact(term), term, idfOf(term), exactQuality);
    for (const expansion of index.expand(term, spec.maxExpansions)) {
      absorb(
        expansion.postings,
        expansion.term,
        idfOf(expansion.term),
        prefixQuality,
      );
    }
  }

  return [...found.entries()]
    .filter(([, entry]) => entry.score > 0)
    .map(([document, entry]) => ({
      document,
      score: entry.score,
      matched: [...entry.reasons.values()]
        .sort((left, right) => weights[right.field] - weights[left.field])
        .slice(0, spec.maxReasons),
    }))
    .sort((left, right) =>
      right.score === left.score
        ? left.document - right.document
        : right.score - left.score,
    );
}
