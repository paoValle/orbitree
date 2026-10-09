import { FIELD_SEP } from './command.ts';
import type { ParseResult } from './status.ts';

export interface Commit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly author: { readonly name: string; readonly email: string };
  /** Unix seconds. */
  readonly authoredAt: number;
  readonly committedAt: number;
  readonly subject: string;
}

export interface Ref {
  readonly name: string;
  readonly shortName: string;
  readonly target: string;
  readonly kind: 'branch' | 'remote' | 'tag' | 'other';
  readonly isHead: boolean;
  readonly upstream: string | null;
  /** Set for a symbolic ref such as `origin/HEAD`. */
  readonly symref: string | null;
}

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function parseLog(stdout: string): ParseResult<readonly Commit[]> {
  const commits: Commit[] = [];
  const seen = new Set<string>();
  for (const record of splitRecords(stdout)) {
    const fields = record.split(FIELD_SEP);
    const [hash, parents, name, email, authoredAt, committedAt, ...subjectParts] = fields;
    if (hash === undefined || !HASH.test(hash)) {
      return { ok: false, error: 'record does not start with a commit hash', record };
    }
    if (seen.has(hash)) {
      // Two rows for one commit would draw it twice; better a loud failure than a
      // graph that quietly lies about the history.
      return { ok: false, error: `commit ${hash} appears twice in the log`, record };
    }
    seen.add(hash);

    const parentList = (parents ?? '').trim() === '' ? [] : (parents as string).split(' ');
    for (const parent of parentList) {
      if (!HASH.test(parent)) return { ok: false, error: `bad parent hash "${parent}"`, record };
    }
    // The subject is the only free-form field, so anything after it is part of it: a
    // separator inside a commit message is preserved rather than treated as a field.
    const subject = subjectParts.join(FIELD_SEP);

    commits.push({
      hash,
      parents: parentList,
      author: { name: name ?? '', email: email ?? '' },
      authoredAt: toSeconds(authoredAt),
      committedAt: toSeconds(committedAt),
      subject,
    });
  }
  return { ok: true, value: commits };
}

export function parseRefs(stdout: string): ParseResult<readonly Ref[]> {
  const refs: Ref[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [name, target, type, head, upstream, symref] = line.split(FIELD_SEP);
    if (name === undefined || name === '' || target === undefined) {
      return { ok: false, error: 'a ref line is missing a name or a target', record: line };
    }
    refs.push({
      name,
      shortName: shorten(name),
      target,
      kind: refKind(name, type ?? ''),
      isHead: head === '*',
      upstream: upstream === undefined || upstream === '' ? null : upstream,
      symref: symref === undefined || symref === '' ? null : symref,
    });
  }
  return { ok: true, value: refs };
}

function refKind(name: string, type: string): Ref['kind'] {
  if (name.startsWith('refs/heads/')) return 'branch';
  if (name.startsWith('refs/remotes/')) return 'remote';
  if (name.startsWith('refs/tags/')) return 'tag';
  if (type === 'tag') return 'tag';
  return 'other';
}

function shorten(name: string): string {
  return name.replace(/^refs\/(heads|remotes|tags)\//, '');
}

function splitRecords(stdout: string): string[] {
  const records = stdout.split('\u0000');
  // `git log -z` separates entries with NUL; the last one ends the stream.
  if (records[records.length - 1] === '') records.pop();
  return records.filter((record) => record !== '');
}

function toSeconds(value: string | undefined): number {
  const seconds = Number.parseInt(value ?? '', 10);
  return Number.isFinite(seconds) ? seconds : 0;
}
