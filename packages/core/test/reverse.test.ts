import { describe, expect, it } from 'vitest';
import type { GitCommand } from '../src/git/command.ts';
import { BEFORE_NOTHING, type BeforeState, reverseOf } from '../src/git/reverse.ts';

/**
 * The command that reverses an operation, and the state it needs to know.
 *
 * The state is the whole point: without the commit HEAD was on before, a `reset --hard` has no
 * undo, and without the sha a branch pointed at, a deleted branch cannot be put back. So the cases
 * below are in pairs — the reverse, and what happens when the state is missing — because the second
 * is what a caller reading a record from before this existed will get.
 */
const HEAD = 'a'.repeat(40);
const FEATURE = 'b'.repeat(40);
const V1 = 'c'.repeat(40);

const BEFORE: BeforeState = {
  head: HEAD,
  branch: 'main',
  targets: { feature: FEATURE, v1: V1 },
};

const cases: readonly (readonly [GitCommand, GitCommand | null])[] = [
  [
    { op: 'add', paths: ['a.txt', 'b.txt'] },
    { op: 'unstage', paths: ['a.txt', 'b.txt'] },
  ],
  [
    { op: 'unstage', paths: ['a.txt'] },
    { op: 'add', paths: ['a.txt'] },
  ],
  [
    { op: 'commit', message: 'x' },
    { op: 'reset-soft', rev: HEAD },
  ],
  [
    { op: 'merge', ref: 'feature' },
    { op: 'reset-hard', rev: HEAD },
  ],
  [{ op: 'pull' }, { op: 'reset-hard', rev: HEAD }],
  [
    { op: 'reset-hard', rev: 'HEAD~1' },
    { op: 'reset-hard', rev: HEAD },
  ],
  // The reverses that are operations of their own, added for this: a commit is undone by moving the
  // pointer softly, and a resolution by asking git for the conflict back.
  [
    { op: 'commit', message: 'x', body: 'y' },
    { op: 'reset-soft', rev: HEAD },
  ],
  [{ op: 'reset-soft', rev: 'HEAD~1' }, null],
  [{ op: 'regenerate-conflict', paths: ['f.txt'] }, null],
  [
    { op: 'branch-create', name: 'new' },
    { op: 'branch-delete', name: 'new' },
  ],
  [
    { op: 'branch-rename', name: 'feature', to: 'renamed' },
    { op: 'branch-rename', name: 'renamed', to: 'feature' },
  ],
  [
    { op: 'branch-delete', name: 'feature' },
    { op: 'branch-create', name: 'feature', start: FEATURE },
  ],
  [
    { op: 'tag-create', name: 'v2', rev: 'HEAD' },
    { op: 'tag-delete', name: 'v2' },
  ],
  [
    { op: 'tag-delete', name: 'v1' },
    { op: 'tag-create', name: 'v1', rev: V1 },
  ],
  [
    { op: 'checkout', ref: 'feature' },
    { op: 'checkout', ref: 'main' },
  ],
  [{ op: 'stash-push' }, { op: 'stash-pop' }],
  [{ op: 'stash-pop' }, { op: 'stash-push' }],
  [
    { op: 'take-side', side: 'ours', paths: ['f.txt'] },
    { op: 'regenerate-conflict', paths: ['f.txt'] },
  ],
  [
    { op: 'resolve-conflict', path: 'f.txt', region: 0, take: 'ours' },
    { op: 'regenerate-conflict', paths: ['f.txt'] },
  ],
  // The ones whose reverse is not a command: work that was never committed, a decision rather than
  // a line, and a read.
  [{ op: 'clean' }, null],
  [{ op: 'discard', paths: ['a.txt'] }, null],
  [{ op: 'discard-hunk', path: 'a.txt', hunk: 0 }, null],
  [{ op: 'stash-drop', selector: 'stash@{0}' }, null],
  [{ op: 'stash-apply', selector: 'stash@{0}' }, null],
  [{ op: 'merge-abort' }, null],
  [{ op: 'fetch' }, null],
  [{ op: 'push', remote: 'origin', branch: 'main' }, null],
  // A remote is a name and two URLs in the config: adding and renaming it are undone by their own
  // opposites, both of which carry the name, and the other two are not undone at all — the URL that
  // was there is in neither command.
  [
    { op: 'remote-add', name: 'origin', url: 'git@example.invalid:x/y.git' },
    { op: 'remote-remove', name: 'origin' },
  ],
  [
    { op: 'remote-rename', name: 'origin', to: 'upstream' },
    { op: 'remote-rename', name: 'upstream', to: 'origin' },
  ],
  [{ op: 'remote-remove', name: 'origin' }, null],
  [{ op: 'remote-set-url', name: 'origin', url: '../elsewhere' }, null],
  [{ op: 'remote-list' }, null],
  [{ op: 'identity' }, null],
  [{ op: 'status' }, null],
];

describe('the command that reverses an operation', () => {
  it('names one for every operation that has one, and says nothing for the rest', () => {
    for (const [command, expected] of cases) {
      expect({ op: command.op, reverse: reverseOf(command, BEFORE) }).toEqual({
        op: command.op,
        reverse: expected,
      });
    }
  });

  it('a detached head is put back by sha, and a branch by its name', () => {
    expect(reverseOf({ op: 'checkout', ref: 'feature' }, { ...BEFORE, branch: null })).toEqual({
      op: 'checkout',
      ref: HEAD,
      detach: true,
    });
    expect(reverseOf({ op: 'checkout', ref: 'feature' }, BEFORE_NOTHING)).toBeNull();
  });

  it('without the state before, the operations that need it have no reverse', () => {
    // Not a wrong command and not an empty one: nothing, so that a caller can say "this one cannot
    // be undone from here" instead of offering a line that would fail or, worse, half work.
    for (const command of [
      { op: 'reset-hard', rev: 'HEAD' },
      { op: 'commit', message: 'x' },
      { op: 'branch-delete', name: 'feature' },
      { op: 'tag-delete', name: 'v1' },
    ] as readonly GitCommand[]) {
      expect({ op: command.op, reverse: reverseOf(command, BEFORE_NOTHING) }).toEqual({
        op: command.op,
        reverse: null,
      });
    }
    // ...and the ones that do not need it still work, because their reverse is about the command.
    expect(reverseOf({ op: 'add', paths: ['a.txt'] }, BEFORE_NOTHING)).toEqual({
      op: 'unstage',
      paths: ['a.txt'],
    });
    expect(reverseOf({ op: 'branch-rename', name: 'a', to: 'b' }, BEFORE_NOTHING)).toEqual({
      op: 'branch-rename',
      name: 'b',
      to: 'a',
    });
  });
});
