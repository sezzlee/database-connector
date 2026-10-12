import type { Vocabulary } from "@sezzlee/mcp-core";

export interface DbVocabulary<
  TToolName extends string,
> extends Vocabulary<TToolName> {
  readonly engineLabel: string;
  readonly catalogLabel: string;
  readonly schemaLabel: string;
  readonly objectLabel: string;
  readonly describeTool: TToolName;
  readonly queryTool: TToolName;
  readonly tooManyRowsRecovery: string;
  readonly readOnlyRecovery: string;
}
