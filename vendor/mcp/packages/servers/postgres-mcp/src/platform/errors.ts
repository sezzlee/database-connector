import {
  baseSecretPatterns,
  DbSourceError,
  internalErrorMessage,
  internalErrorRecovery,
  McpSourceError,
  redactSecrets,
  type DbErrorCode,
  type ErrorContext,
  type ErrorFactory,
} from "@sezzlee/db-core";
import { vocabulary } from "./vocabulary.js";

export type SezzleePostgresErrorCode = DbErrorCode;
export class SezzleePostgresError extends DbSourceError {
  declare readonly code: SezzleePostgresErrorCode;
}
export const secretPatterns = [
  ...baseSecretPatterns,
  /(\b(?:host|hostaddr|dbname|user|password|passfile)\s*=\s*)(?:'[^']*'|[^\s;]+)/gi,
  /postgres(?:ql)?:\/\/[^\s]+/gi,
] as const;
export const redact = (detail: string): string =>
  redactSecrets(detail, secretPatterns);
export const fail: ErrorFactory<SezzleePostgresErrorCode> = (
  code,
  message,
  recovery,
) =>
  new SezzleePostgresError(code, redact(message), recovery && redact(recovery));
export function asPostgresError(
  error: unknown,
  context: ErrorContext = {},
): McpSourceError {
  return error instanceof McpSourceError
    ? error
    : fail(
        "internal_error",
        internalErrorMessage(error, context),
        internalErrorRecovery(vocabulary),
      );
}
