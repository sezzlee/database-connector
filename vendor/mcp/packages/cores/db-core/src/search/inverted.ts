import { tokenize } from "./tokenize.js";

export type SearchField =
  "schema" | "name" | "column" | "description" | "columnDescription";

export interface IndexedColumn {
  readonly name: string;
  readonly description?: string;
}

export interface IndexedDocument {
  readonly schema: string;
  readonly name: string;
  readonly description?: string;
  readonly columns: readonly IndexedColumn[];
}

export interface Posting {
  readonly document: number;
  readonly field: SearchField;
  readonly value: string;
}

export interface Expansion {
  readonly term: string;
  readonly postings: readonly Posting[];
}

export interface InvertedIndex {
  readonly documents: number;
  readonly terms: number;
  readonly postings: number;
  exact(term: string): readonly Posting[];
  /** Terms the query term is a strict prefix of, rarest first. */
  expand(term: string, limit: number): readonly Expansion[];
  frequency(term: string): number;
}

interface Bucket {
  readonly postings: Posting[];
  frequency: number;
  last: number;
}

function firstAtOrAfter(terms: readonly string[], prefix: string): number {
  let low = 0;
  let high = terms.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((terms[mid] ?? "") < prefix) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * Builds the term index one document at a time.
 *
 * Guard: document frequency counts documents, not postings. A term in forty
 * columns of one table is one document's worth of evidence; counting the
 * postings would make a wide table look like forty tables agreeing, and the IDF
 * that ranking rests on would report a common word as a rare one.
 */
export function buildIndex(
  documents: readonly IndexedDocument[],
): InvertedIndex {
  const buckets = new Map<string, Bucket>();
  let postings = 0;

  const add = (
    document: number,
    field: SearchField,
    value: string,
    text: string,
  ): void => {
    for (const term of tokenize(text)) {
      let bucket = buckets.get(term);
      if (bucket === undefined) {
        bucket = { postings: [], frequency: 0, last: -1 };
        buckets.set(term, bucket);
      }
      if (bucket.last !== document) {
        bucket.frequency += 1;
        bucket.last = document;
      }
      bucket.postings.push({ document, field, value });
      postings += 1;
    }
  };

  documents.forEach((document, index) => {
    add(index, "schema", document.schema, document.schema);
    add(index, "name", document.name, document.name);
    if (document.description !== undefined) {
      add(index, "description", document.description, document.description);
    }
    for (const column of document.columns) {
      add(index, "column", column.name, column.name);
      if (column.description !== undefined) {
        add(index, "columnDescription", column.name, column.description);
      }
    }
  });

  const sorted = [...buckets.keys()].sort();

  return {
    documents: documents.length,
    terms: sorted.length,
    postings,
    exact: (term) => buckets.get(term)?.postings ?? [],
    frequency: (term) => buckets.get(term)?.frequency ?? 0,
    expand: (term, limit) => {
      const found: Expansion[] = [];
      for (let i = firstAtOrAfter(sorted, term); i < sorted.length; i += 1) {
        const candidate = sorted[i] ?? "";
        if (!candidate.startsWith(term)) {
          break;
        }
        if (candidate !== term) {
          found.push({
            term: candidate,
            postings: buckets.get(candidate)?.postings ?? [],
          });
        }
      }
      return found
        .sort(
          (left, right) =>
            (buckets.get(left.term)?.frequency ?? 0) -
            (buckets.get(right.term)?.frequency ?? 0),
        )
        .slice(0, limit);
    },
  };
}
