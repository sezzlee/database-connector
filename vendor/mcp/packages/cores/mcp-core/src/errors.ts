import type { Vocabulary } from "./vocabulary.js";

export type SourceErrorCode =
  | "invalid_argument"
  | "invalid_cursor"
  | "stale_cursor"
  | "resource_limit"
  | "internal_error";

/**
 * The three-field envelope every tool error is reported as: a machine code, a
 * message, and the line telling the agent what to do next.
 */
export class McpSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export type ErrorFactory<TCode extends string> = (
  code: TCode,
  message: string,
  recovery?: string,
) => McpSourceError;

export interface ErrorContext {
  readonly tool?: string;
  /**
   * Strips whatever this source must never disclose — a filesystem root, a
   * connection secret — from an error string before it reaches the agent.
   *
   * Guard: the core cannot know what a given source considers sensitive, so the
   * redactor is injected rather than chosen here. An absent redactor means the
   * source declared it has nothing to hide, not that redaction was forgotten.
   */
  readonly redact?: (detail: string) => string;
}

export function internalErrorMessage(
  _error: unknown,
  context: ErrorContext,
): string {
  const subject = context.tool ?? "The tool";
  return `${subject} failed unexpectedly.`;
}

export function internalErrorRecovery(vocabulary: Vocabulary<string>): string {
  return `This is a fault in the ${vocabulary.serverName} server, not in the ${vocabulary.subject}. Retrying the same call will not help.`;
}
