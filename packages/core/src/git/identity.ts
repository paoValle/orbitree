/**
 * Parser for `git config --null --show-origin --show-scope --get-regexp '^user\.'`.
 *
 * The same two rules as every other parser in `git/`: it never throws — a record it cannot
 * understand is a value — and it never drops a record, because every `user.*` entry is kept, in the
 * order git printed it, rather than only the three this version happens to name.
 *
 * Why this shape of the command: `--show-scope` and `--show-origin` are what turn "somebody's name
 * is here" into "this name comes from this file, and this is the one in force". `--null` because a
 * value may contain a newline, and with it the record separator is NUL while the key and its value
 * stay separated by exactly one newline.
 *
 * Precedence is git's own: it prints the records in the order it resolves them, so the **last**
 * occurrence of a key is the effective one, and this parser does not have to know the order of
 * `system`, `global`, `local` and `worktree` itself.
 */
import type { ParseResult } from './status.ts';

export interface ConfigRecord {
  /** `system`, `global`, `local`, `worktree`, or `command`. */
  readonly scope: string;
  /** The file it was read from, as git spells it: `file:/path`, or `command line:`. */
  readonly origin: string;
  readonly key: string;
  readonly value: string;
}

export interface IdentityValue {
  readonly value: string;
  readonly scope: string;
  readonly origin: string;
}

export interface Identity {
  /** Who commits are authored as, and where that came from. */
  readonly name: IdentityValue | null;
  readonly email: IdentityValue | null;
  /** `user.signingkey`, or `null` when unset — an empty value signs nothing, so it is unset too. */
  readonly signingKey: IdentityValue | null;
  /** Every `user.*` record, in the order git printed it: the last of a key is the one in force. */
  readonly records: readonly ConfigRecord[];
}

export function parseIdentity(stdout: string): ParseResult<Identity> {
  const fields = stdout.split('\u0000');
  // A NUL that ends the last record is a terminator, not a fourth field.
  if (fields.length > 0 && fields[fields.length - 1] === '') fields.pop();
  if (fields.length % 3 !== 0) {
    return {
      ok: false,
      error: 'a config record is not <scope>, <origin>, <key>\\n<value>',
      record: fields.slice(Math.floor(fields.length / 3) * 3).join('\u0000'),
    };
  }

  const records: ConfigRecord[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index] ?? '';
    const origin = fields[index + 1] ?? '';
    const rest = fields[index + 2] ?? '';
    const newline = rest.indexOf('\n');
    if (newline === -1) {
      return { ok: false, error: 'a config record has no key/value separator', record: rest };
    }
    records.push({
      scope,
      origin,
      key: rest.slice(0, newline),
      value: rest.slice(newline + 1),
    });
  }

  // Last wins, which is git's own precedence and the only rule this parser needs to know.
  const inForce = new Map<string, ConfigRecord>();
  for (const record of records) inForce.set(record.key, record);

  const partOf = (key: string): IdentityValue | null => {
    const record = inForce.get(key);
    if (record === undefined || record.value === '') return null;
    return { value: record.value, scope: record.scope, origin: record.origin };
  };

  return {
    ok: true,
    value: {
      name: partOf('user.name'),
      email: partOf('user.email'),
      signingKey: partOf('user.signingkey'),
      records,
    },
  };
}
