export interface Vocabulary<TToolName extends string> {
  readonly serverName: string;
  readonly subject: string;
  readonly listTool: TToolName;
}
