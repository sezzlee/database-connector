import type { ColumnDescriptor } from "../model/value.js";
import type { IntrospectionQuery, RowRecord } from "../model/dialect.js";
import type { QueryRunner } from "../query/execute.js";

/**
 * Guard: `more` travels with the rows. Returning a bare array is what let a
 * listing the engine had already cut report itself complete — the fact that the
 * answer was partial died at this boundary and every caller above it was blind.
 */
export interface Introspected<T> {
  readonly rows: readonly T[];
  readonly more: boolean;
}

function toRecord(
  columns: readonly ColumnDescriptor[],
  row: readonly unknown[],
): RowRecord {
  const record: Record<string, unknown> = {};
  for (const column of columns) {
    record[column.name] = row[column.ordinal];
  }
  return record;
}

/**
 * Runs one introspection question and projects every row with the projector it
 * was born with.
 */
export async function introspect<T>(
  runner: QueryRunner,
  query: IntrospectionQuery<T>,
  signal?: AbortSignal,
): Promise<Introspected<T>> {
  const result = await runner.run(query.spec, signal);
  return {
    rows: result.rows.map((row) =>
      query.project(toRecord(result.columns, row)),
    ),
    more: result.more,
  };
}

export async function introspectOne<T>(
  runner: QueryRunner,
  query: IntrospectionQuery<T>,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const { rows } = await introspect(runner, query, signal);
  return rows[0];
}
