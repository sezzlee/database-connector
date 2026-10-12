/**
 * A pattern whose whole match is replaced by `[redacted]`, except for an
 * optional capture group 1 kept as a prefix and an optional group 2 kept as a
 * suffix — so `Password=hunter2` becomes `Password=[redacted]` rather than
 * losing the key that makes the message legible.
 */
export type SecretPattern = RegExp;

/**
 * Guard: these cover the `connection_string` and `credential` classes named in
 * packages/http/spec/error-mapping.md. They are a second layer, not the control — an
 * error that never carries a secret in the first place is what actually keeps
 * one out of a response. Every pattern is linear: no nested quantifier, so a
 * hostile driver message cannot make redaction the slow path.
 */
export const baseSecretPatterns: readonly SecretPattern[] = [
  /(\b(?:password|pwd|secret|token|api[_-]?key|accesskey|sharedaccesskey)\s*=\s*)(?:\{[^}]*\}?|'[^']*'?|"[^"]*"?|[^;,\s]*)/gi,
  /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*(@)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9._-]{10,}/g,
];

export function redactSecrets(
  detail: string,
  patterns: readonly SecretPattern[],
): string {
  let out = detail;
  for (const pattern of patterns) {
    out = out.replace(pattern, (...args: unknown[]): string => {
      /**
       * Guard: `String.replace` passes the offset and the subject string after
       * the capture groups, so the groups cannot be read by fixed index — with
       * no groups at all, `args[2]` is the whole input and splicing it back in
       * duplicates the message. The offset is the first number, which is what
       * marks the end of the groups.
       */
      const end = args.findIndex((value) => typeof value === "number");
      const groups = end === -1 ? [] : args.slice(1, end);
      const prefix = typeof groups[0] === "string" ? groups[0] : "";
      const suffix = typeof groups[1] === "string" ? groups[1] : "";
      return `${prefix}[redacted]${suffix}`;
    });
  }
  return out;
}
