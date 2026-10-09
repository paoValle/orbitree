/**
 * Credentials end up in more places than expected: remote URLs, git's own error messages,
 * `gh`/`glab` output pasted into an issue. Redaction happens once, on the way in, so no
 * caller has to remember.
 */

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi;
const KNOWN_TOKENS =
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|gldt-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;
const BEARER = /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi;

export function redact(text: string): string {
  return text
    .replace(URL_CREDENTIALS, '$1***@')
    .replace(KNOWN_TOKENS, '***redacted***')
    .replace(BEARER, '$1 ***redacted***');
}

/** True when `redact` found nothing to remove — used by the tests, not by production code. */
export function isClean(text: string): boolean {
  return redact(text) === text;
}
