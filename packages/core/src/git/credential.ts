/**
 * Parser for `git credential fill`, and the request that goes into it.
 *
 * `git credential fill` reads a request on stdin — `protocol=https`, `host=github.com`, and a blank
 * line — and answers with `key=value` lines, the useful ones being `username` and `password`. The
 * answer comes from whatever the user configured: the macOS keychain, Git Credential Manager,
 * `gh auth setup-git`, or nothing at all. That is the point of asking git rather than the keychain
 * directly — this product does not need to know which helper somebody uses, and it must never write
 * one into a config file of its own.
 *
 * Two rules, as in every parser here: it never throws, and it never drops a record — every `key=value`
 * line git printed is kept in `entries`, in the order it came.
 *
 * **What is deliberately not here: the secret.** The password is a credential the product has no use
 * for, and a value that is never held cannot leak; `hasPassword` says whether the helper answered with
 * one, which is the whole of the question this command asks. The rule that a parser keeps every record
 * is about not losing git's *shape* — a key this version does not know stays in `entries`, and the one
 * key that is withheld is withheld on purpose, with the reason written down.
 */
import type { ParseResult } from './status.ts';

/** The request git is asked to fill: a protocol, a host, and optionally a path and a username. */
export interface CredentialRequest {
  readonly protocol: string;
  readonly host: string;
  readonly path?: string;
  readonly username?: string;
}

export interface Credential {
  /** The username the helper answered with, or `null` when it answered with none. */
  readonly username: string | null;
  /** Whether a password came back. Not the password: see the note at the top. */
  readonly hasPassword: boolean;
  /** Every `key=value` line git printed, in order, except the password. */
  readonly entries: readonly { readonly key: string; readonly value: string }[];
  /** The text git printed, with the password line withheld. */
  readonly raw: string;
  /** Whether anything answered at all. */
  readonly available: boolean;
}

/**
 * The request, as git reads it: one `key=value` per line and a blank line to finish. `\n` line endings
 * because that is the protocol, not the platform.
 */
export function credentialRequestText(request: CredentialRequest): string {
  const lines = [`protocol=${request.protocol}`, `host=${request.host}`];
  if (request.path !== undefined) lines.push(`path=${request.path}`);
  if (request.username !== undefined) lines.push(`username=${request.username}`);
  lines.push('', '');
  return lines.join('\n');
}

export function parseCredential(stdout: string): ParseResult<Credential> {
  const entries: { key: string; value: string }[] = [];
  let raw = '';
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const equals = line.indexOf('=');
    if (equals === -1) {
      return { ok: false, error: 'a credential line is not `key=value`', record: line };
    }
    const key = line.slice(0, equals);
    const value = line.slice(equals + 1);
    entries.push({ key, value });
    // The one record this parser withholds, and the reason is at the top of the file.
    raw += key === 'password' ? 'password=***\n' : `${line}\n`;
  }

  const username = entries.find((entry) => entry.key === 'username')?.value ?? null;
  const hasPassword = entries.some((entry) => entry.key === 'password' && entry.value !== '');
  return {
    ok: true,
    value: {
      username,
      hasPassword,
      entries: entries.filter((entry) => entry.key !== 'password'),
      raw,
      available: username !== null || hasPassword,
    },
  };
}
