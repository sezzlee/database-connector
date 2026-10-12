import {
  columnDescriptor,
  sqlText,
  type CatalogColumn,
  type CatalogObject,
  type CatalogScope,
  type ColumnDescriptor,
  type Introspection,
  type IntrospectionQuery,
  type KeyEntry,
  type PrincipalPosture,
  type QueryParameter,
  type QuerySpec,
  type RowRecord,
  type ServerFacts,
  type TableRef,
} from "@sezzlee/db-core";
import { describeType } from "./types.js";

/**
 * Guard: the column list is joined server-side with the unit separator rather
 * than a comma, because a bracketed identifier may legally contain a comma and
 * splitting on one would invent columns that do not exist.
 */
const SEPARATOR = "char(31)";

const spec = (
  sql: string,
  parameters: readonly QueryParameter[],
  timeoutMs: number,
  maxRows: number,
): QuerySpec => ({ sql: sqlText(sql), parameters, timeoutMs, maxRows });

const text = (row: RowRecord, key: string): string =>
  typeof row[key] === "string" ? row[key] : String(row[key] ?? "");

const list = (row: RowRecord, key: string): readonly string[] => {
  const raw = row[key];
  return typeof raw === "string" && raw.length > 0 ? raw.split("\u001f") : [];
};

const optional = (row: RowRecord, key: string): string | undefined => {
  const raw = row[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
};

/** Guard: an answer this projector does not recognise is read as the worst posture, never as read-only. */
const principalPosture = (value: string): PrincipalPosture =>
  value === "read_only" || value === "writable" ? value : "administrator";

const number = (row: RowRecord, key: string): number | undefined => {
  const raw = row[key];
  return typeof raw === "number" ? raw : undefined;
};

export interface IntrospectionCaps {
  readonly maxColumns: number;
  readonly maxKeys: number;
}

/**
 * Guard: each question carries its own row cap, one past the limit db-core
 * enforces. A single shared cap lets the driver cut a column list below the
 * limit that would have refused it, so the refusal never fires and the table is
 * described with columns missing.
 */
export function createIntrospection(
  timeoutMs: number,
  caps: IntrospectionCaps,
): Introspection {
  return {
    server: (): IntrospectionQuery<ServerFacts> => ({
      spec: spec(
        `select
           cast(serverproperty('ProductVersion') as nvarchar(128)) as engineVersion,
           db_name() as [catalog],
           current_user as principal`,
        [],
        timeoutMs,
        1,
      ),
      project: (row) => ({
        engineVersion: text(row, "engineVersion"),
        catalog: text(row, "catalog"),
        principal: text(row, "principal"),
      }),
    }),

    principal: (): IntrospectionQuery<PrincipalPosture> => ({
      spec: spec(
        `select case
           when is_srvrolemember('sysadmin') = 1
             or is_srvrolemember('serveradmin') = 1
             or is_srvrolemember('securityadmin') = 1
             or is_srvrolemember('setupadmin') = 1
             or is_srvrolemember('processadmin') = 1
             or is_srvrolemember('dbcreator') = 1
             or is_srvrolemember('bulkadmin') = 1
             or is_rolemember('db_owner') = 1
             or is_rolemember('db_securityadmin') = 1
             or is_rolemember('db_accessadmin') = 1
             or has_perms_by_name(db_name(), 'DATABASE', 'CONTROL') = 1
             or (case when serverproperty('EngineEdition') = 5 then 0
                  else (select count(*)
                        from (values ('CONTROL SERVER'), ('ALTER ANY LOGIN'), ('ALTER ANY LINKED SERVER'), ('ALTER ANY DATABASE'), ('ADMINISTER BULK OPERATIONS'), ('ALTER SETTINGS'), ('IMPERSONATE ANY LOGIN')) as s([name])
                        where has_perms_by_name(null, null, s.[name]) = 1) end) > 0
             then 'administrator'
           when is_rolemember('db_datawriter') = 1
             or is_rolemember('db_ddladmin') = 1
             or exists (
               select 1
               from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('ALTER'), ('CREATE TABLE'), ('CREATE VIEW'), ('CREATE PROCEDURE'), ('CREATE FUNCTION'), ('ALTER ANY SCHEMA')) as p([name])
               where has_perms_by_name(db_name(), 'DATABASE', p.[name]) = 1)
             or exists (
               select 1
               from sys.objects as o
               cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('ALTER')) as p([name])
               where o.type in ('U', 'V') and o.is_ms_shipped = 0
                 and has_perms_by_name(quotename(schema_name(o.schema_id)) + N'.' + quotename(o.name), 'OBJECT', p.[name]) = 1)
             or exists (
               select 1
               from sys.sequences as q
               cross join (values ('UPDATE'), ('ALTER')) as p([name])
               where has_perms_by_name(quotename(schema_name(q.schema_id)) + N'.' + quotename(q.name), 'OBJECT', p.[name]) = 1)
             then 'writable'
           else 'read_only'
         end as posture`,
        [],
        timeoutMs,
        1,
      ),
      project: (row) => principalPosture(text(row, "posture")),
    }),

    catalogObjects: (
      scope: CatalogScope,
    ): IntrospectionQuery<CatalogObject> => ({
      spec: spec(
        `select top (@maxObjects)
           s.name as [schema],
           o.name as [name],
           case o.kind when 'V' then 'view' else 'table' end as [kind],
           cast(p.value as nvarchar(4000)) as [description]
         from (
           select name, schema_id, object_id, 'U' as kind from sys.tables
           union all
           select name, schema_id, object_id, 'V' as kind from sys.views
         ) o
         join sys.schemas s on s.schema_id = o.schema_id
         left join sys.extended_properties p
           on p.major_id = o.object_id
          and p.minor_id = 0
          and p.class = 1
          and p.name = 'MS_Description'
         order by s.name, o.name`,
        [
          {
            name: "maxObjects",
            value: scope.maxObjects + 1,
            kind: "integer",
          },
        ],
        timeoutMs,
        scope.maxObjects + 1,
      ),
      project: (row) => {
        const description = optional(row, "description");
        return {
          schema: text(row, "schema"),
          name: text(row, "name"),
          kind: text(row, "kind") === "view" ? "view" : "table",
          ...(description === undefined ? {} : { description }),
        };
      },
    }),

    /**
     * Guard: the same object order as `catalogObjects`, because the snapshot
     * pairs the two reads positionally to find where a cut stopped. A different
     * order makes that boundary unknowable and leaves the index partial in a way
     * no field can report.
     */
    catalogColumns: (
      scope: CatalogScope,
    ): IntrospectionQuery<CatalogColumn> => ({
      spec: spec(
        `select top (@maxRows)
           s.name as [schema],
           o.name as [name],
           c.name as [column],
           cast(c.column_id as int) as [ordinal],
           cast(p.value as nvarchar(4000)) as [description]
         from (
           select name, schema_id, object_id from sys.tables
           union all
           select name, schema_id, object_id from sys.views
         ) o
         join sys.schemas s on s.schema_id = o.schema_id
         join sys.columns c on c.object_id = o.object_id
         left join sys.extended_properties p
           on p.major_id = c.object_id
          and p.minor_id = c.column_id
          and p.class = 1
          and p.name = 'MS_Description'
         order by s.name, o.name, c.column_id`,
        [{ name: "maxRows", value: scope.maxRows + 1, kind: "integer" }],
        timeoutMs,
        scope.maxRows + 1,
      ),
      project: (row) => {
        const description = optional(row, "description");
        return {
          schema: text(row, "schema"),
          name: text(row, "name"),
          column: text(row, "column"),
          ordinal: number(row, "ordinal") ?? 0,
          ...(description === undefined ? {} : { description }),
        };
      },
    }),

    columns: (ref: TableRef): IntrospectionQuery<ColumnDescriptor> => ({
      spec: spec(
        `select
           c.name as [name],
           cast(row_number() over (order by c.column_id) - 1 as int) as [ordinal],
           t.name as [nativeType],
           c.is_nullable as [nullable],
           c.max_length as [maxLength],
           c.precision as [precision],
           c.scale as [scale]
         from sys.columns c
         join sys.types t on t.user_type_id = c.user_type_id
         where c.object_id = object_id(quotename(@schema) + '.' + quotename(@table))
         order by c.column_id`,
        [
          { name: "schema", value: ref.schema, kind: "text" },
          { name: "table", value: ref.name, kind: "text" },
        ],
        timeoutMs,
        caps.maxColumns + 1,
      ),
      project: (row) => {
        const nativeType = text(row, "nativeType");
        const precision = number(row, "precision");
        const scale = number(row, "scale");
        const maxLength = number(row, "maxLength");
        return columnDescriptor(
          text(row, "name"),
          number(row, "ordinal") ?? 0,
          row["nullable"] === true || row["nullable"] === 1,
          nativeType,
          describeType({
            typeName: nativeType,
            ...(maxLength === undefined ? {} : { maxLength }),
            ...(precision === undefined ? {} : { precision }),
            ...(scale === undefined ? {} : { scale }),
          }),
        );
      },
    }),

    keys: (ref: TableRef): IntrospectionQuery<KeyEntry> => ({
      spec: spec(
        `select
           kc.name as [name],
           case kc.type when 'PK' then 'primary' else 'unique' end as [kind],
           string_agg(c.name, ${SEPARATOR}) within group (order by ic.key_ordinal) as [columns],
           cast(null as nvarchar(128)) as [referencedSchema],
           cast(null as nvarchar(128)) as [referencedTable],
           cast(null as nvarchar(max)) as [referencedColumns]
         from sys.key_constraints kc
         join sys.index_columns ic
           on ic.object_id = kc.parent_object_id
          and ic.index_id = kc.unique_index_id
          and ic.key_ordinal > 0
         join sys.columns c
           on c.object_id = ic.object_id and c.column_id = ic.column_id
         where kc.parent_object_id = object_id(quotename(@schema) + '.' + quotename(@table))
         group by kc.name, kc.type

         union all

         select
           fk.name as [name],
           'foreign' as [kind],
           string_agg(pc.name, ${SEPARATOR}) within group (order by fkc.constraint_column_id) as [columns],
           rs.name as [referencedSchema],
           rt.name as [referencedTable],
           string_agg(rc.name, ${SEPARATOR}) within group (order by fkc.constraint_column_id) as [referencedColumns]
         from sys.foreign_keys fk
         join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
         join sys.columns pc
           on pc.object_id = fkc.parent_object_id and pc.column_id = fkc.parent_column_id
         join sys.columns rc
           on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
         join sys.tables rt on rt.object_id = fk.referenced_object_id
         join sys.schemas rs on rs.schema_id = rt.schema_id
         where fk.parent_object_id = object_id(quotename(@schema) + '.' + quotename(@table))
         group by fk.name, rs.name, rt.name`,
        [
          { name: "schema", value: ref.schema, kind: "text" },
          { name: "table", value: ref.name, kind: "text" },
        ],
        timeoutMs,
        caps.maxKeys + 1,
      ),
      project: (row) => {
        const kind = text(row, "kind");
        const referencedSchema = row["referencedSchema"];
        const referencedTable = row["referencedTable"];
        return {
          name: text(row, "name"),
          kind:
            kind === "primary"
              ? "primary"
              : kind === "foreign"
                ? "foreign"
                : "unique",
          columns: list(row, "columns"),
          ...(typeof referencedSchema === "string" ? { referencedSchema } : {}),
          ...(typeof referencedTable === "string" ? { referencedTable } : {}),
          ...(kind === "foreign"
            ? { referencedColumns: list(row, "referencedColumns") }
            : {}),
        };
      },
    }),
  };
}
