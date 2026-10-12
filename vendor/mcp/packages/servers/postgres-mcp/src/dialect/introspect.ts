import {
  columnDescriptor,
  sqlText,
  type CatalogColumn,
  type CatalogObject,
  type Introspection,
  type IntrospectionQuery,
  type KeyEntry,
  type PrincipalPosture,
  type QueryParameter,
  type RowRecord,
  type ServerFacts,
} from "@sezzlee/db-core";
import { describeType } from "./types.js";

const visible =
  "c.relkind in ('r','p','v','m','f') and not c.relispartition and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%' and has_schema_privilege(n.oid,'USAGE') and has_table_privilege(c.oid,'SELECT')";
const orderedObjects = `select n.nspname as schema, c.relname as name, c.oid, c.relkind, obj_description(c.oid,'pg_class') as description from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where ${visible} order by n.nspname collate "C", c.relname collate "C" limit $1`;
const text = (row: RowRecord, key: string): string => String(row[key] ?? "");
const optionalDescription = (row: RowRecord) =>
  typeof row["description"] === "string" && row["description"].length > 0
    ? { description: row["description"] }
    : {};
const number = (row: RowRecord, key: string) =>
  row[key] === null || row[key] === undefined ? undefined : Number(row[key]);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];
/** Guard: an answer this projector does not recognise is read as the worst posture, never as read-only. */
const principalPosture = (value: string): PrincipalPosture =>
  value === "read_only" || value === "writable" ? value : "administrator";
const administrator = `exists (select 1 from pg_catalog.pg_roles s where (s.rolsuper or s.rolcreaterole or s.rolreplication) and pg_catalog.pg_has_role(r.oid, s.oid, 'MEMBER')) or exists (select 1 from pg_catalog.pg_roles g where g.rolname in ('pg_read_server_files','pg_write_server_files','pg_execute_server_program','pg_signal_backend') and pg_catalog.pg_has_role(r.oid, g.oid, 'MEMBER'))`;
const writable = `pg_catalog.has_database_privilege(pg_catalog.current_database(), 'CREATE') or exists (select 1 from pg_catalog.pg_namespace n where n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp_%' and pg_catalog.has_schema_privilege(n.oid, 'CREATE')) or exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p','v','m','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%' and pg_catalog.has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))`;

export function createIntrospection(
  timeoutMs: number,
  bounds: { readonly maxColumns: number; readonly maxKeys: number },
): Introspection {
  function question<T>(
    sql: string,
    parameters: readonly QueryParameter[],
    maxRows: number,
    project: (row: RowRecord) => T,
  ): IntrospectionQuery<T> {
    return {
      spec: { sql: sqlText(sql), parameters, timeoutMs, maxRows },
      project,
    };
  }
  const identity = (schema: string, name: string): QueryParameter[] => [
    { name: "schema", value: schema },
    { name: "name", value: name },
  ];
  return {
    catalogObjects: (scope) =>
      question<CatalogObject>(
        orderedObjects,
        [{ name: "limit", value: scope.maxObjects + 1 }],
        scope.maxObjects + 1,
        (row) => ({
          schema: text(row, "schema"),
          name: text(row, "name"),
          kind: ["v", "m"].includes(text(row, "relkind")) ? "view" : "table",
          ...optionalDescription(row),
        }),
      ),
    catalogColumns: (scope) =>
      question<CatalogColumn>(
        `with objects as (${orderedObjects}) select o.schema, o.name, a.attname as column, a.attnum as ordinal, col_description(o.oid,a.attnum) as description from objects o join pg_catalog.pg_attribute a on a.attrelid=o.oid where a.attnum>0 and not a.attisdropped order by o.schema collate "C", o.name collate "C", a.attnum`,
        [{ name: "limit", value: scope.maxObjects + 1 }],
        scope.maxRows + 1,
        (row) => ({
          schema: text(row, "schema"),
          name: text(row, "name"),
          column: text(row, "column"),
          ordinal: Number(row["ordinal"]),
          ...optionalDescription(row),
        }),
      ),
    columns: (ref) =>
      question(
        `select a.attname as name, a.attnum-1 as ordinal, not a.attnotnull as nullable, coalesce(bt.typname,t.typname) as type,
      case when coalesce(bt.typname,t.typname) in ('varchar','bpchar') and a.atttypmod>=4 then a.atttypmod-4 end as max_length,
      case when coalesce(bt.typname,t.typname)='numeric' and a.atttypmod>=4 then ((a.atttypmod-4)>>16)&65535 end as precision,
      case when coalesce(bt.typname,t.typname)='numeric' and a.atttypmod>=4 then (((a.atttypmod-4)&2047)#1024)-1024 end as scale
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace join pg_catalog.pg_attribute a on a.attrelid=c.oid join pg_catalog.pg_type t on t.oid=a.atttypid left join pg_catalog.pg_type bt on bt.oid=t.typbasetype where n.nspname = $1 and c.relname = $2 and ${visible} and a.attnum>0 and not a.attisdropped order by a.attnum`,
        identity(ref.schema, ref.name),
        bounds.maxColumns,
        (row) => {
          const maxLength = number(row, "max_length"),
            precision = number(row, "precision"),
            scale = number(row, "scale"),
            typeName = text(row, "type");
          return columnDescriptor(
            text(row, "name"),
            Number(row["ordinal"]),
            row["nullable"] === true,
            typeName,
            describeType({
              typeName,
              ...(maxLength === undefined ? {} : { maxLength }),
              ...(precision === undefined ? {} : { precision }),
              ...(scale === undefined ? {} : { scale }),
            }),
          );
        },
      ),
    keys: (ref) =>
      question<KeyEntry>(
        `select k.conname as name, k.contype as kind,
      array(select a.attname from unnest(k.conkey) with ordinality u(attnum,position) join pg_catalog.pg_attribute a on a.attrelid=k.conrelid and a.attnum=u.attnum order by u.position) as columns,
      rn.nspname as referenced_schema, rc.relname as referenced_table,
      array(select a.attname from unnest(k.confkey) with ordinality u(attnum,position) join pg_catalog.pg_attribute a on a.attrelid=k.confrelid and a.attnum=u.attnum order by u.position) as referenced_columns
      from pg_catalog.pg_constraint k join pg_catalog.pg_class c on c.oid=k.conrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace left join pg_catalog.pg_class rc on rc.oid=k.confrelid left join pg_catalog.pg_namespace rn on rn.oid=rc.relnamespace where n.nspname = $1 and c.relname = $2 and ${visible} and k.contype in ('p','u','f') order by k.conname collate "C"`,
        identity(ref.schema, ref.name),
        bounds.maxKeys,
        (row) => ({
          name: text(row, "name"),
          kind:
            text(row, "kind") === "p"
              ? "primary"
              : text(row, "kind") === "u"
                ? "unique"
                : "foreign",
          columns: strings(row["columns"]),
          ...(row["referenced_table"] === null ||
          row["referenced_table"] === undefined
            ? {}
            : {
                referencedSchema: text(row, "referenced_schema"),
                referencedTable: text(row, "referenced_table"),
                referencedColumns: strings(row["referenced_columns"]),
              }),
        }),
      ),
    principal: () =>
      question<PrincipalPosture>(
        `select case when ${administrator} then 'administrator' when ${writable} then 'writable' else 'read_only' end as posture from pg_catalog.pg_roles r where r.rolname = current_user`,
        [],
        1,
        (row) => principalPosture(text(row, "posture")),
      ),
    server: () =>
      question<ServerFacts>(
        "select version() as engine_version, current_database() as catalog, current_user as principal",
        [],
        1,
        (row) => ({
          engineVersion: text(row, "engine_version"),
          catalog: text(row, "catalog"),
          principal: text(row, "principal"),
        }),
      ),
  };
}
