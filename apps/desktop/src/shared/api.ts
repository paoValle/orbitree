/**
 * The contract between the three processes.
 *
 * The renderer is a trust boundary, not an extension of the main process: what arrives over
 * IPC is parsed with these schemas before a single git argument is built. `gitCommandSchema`
 * is asserted to cover `GitCommand` at compile time, so the IPC surface cannot drift away
 * from what the core actually accepts.
 */
import type {
  CommitData,
  DiffFile,
  GitCommand,
  GraphData,
  Progress,
  Ref,
  RepoState,
} from '@orbitree/core';
import { z } from 'zod';
import { CHANNELS } from './channels.ts';

/** Re-exported so the renderer has one import for the types it draws with. */
export type {
  CommitData,
  DiffFile,
  DiffHunk,
  DiffLine,
  GitCommand,
  GraphData,
  PendingOperation,
  Ref,
  RepoState,
  StatusEntry,
  WorkingTreeNode,
} from '@orbitree/core';

export { CHANNELS };

const literal = <T extends string>(value: T): z.ZodLiteral<T> => z.literal(value);

/**
 * The operation git is in the middle of, and the refs it reads to answer the question.
 *
 * Written out here rather than imported from the core on purpose: the renderer is a web page
 * and imports the core's *types* only. The compile-time assertion on `repoStateSchema` is what
 * keeps this list and the core's `PendingOperation` from drifting apart — add a state to the
 * core without touching this and it stops compiling.
 */
const PENDING_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD'] as const;
const PENDING_OPERATIONS = ['merge', 'cherry-pick', 'rebase'] as const;

/** Re-exported for the renderer, which does not import the core at runtime: a type import is erased. */
export type { Progress };
/** One part of the identity: the value in force, and where it was read from. */
export type IdentityValue = NonNullable<IdentityPayload['identity']['name']>;

export const gitCommandSchema = z.discriminatedUnion('op', [
  z.object({ op: literal('version') }),
  z.object({ op: literal('repo-root') }),
  z.object({ op: literal('status') }),
  z.object({
    op: literal('graph'),
    limit: z.int().min(1).max(5000),
    all: z.exactOptional(z.boolean()),
    rev: z.exactOptional(z.string().min(1)),
    hide: z.exactOptional(z.readonly(z.array(z.string()))),
  }),
  z.object({
    op: literal('count'),
    all: z.exactOptional(z.boolean()),
    rev: z.exactOptional(z.string().min(1)),
  }),
  z.object({ op: literal('refs') }),
  z.object({
    op: literal('diff'),
    rev: z.exactOptional(z.string()),
    cached: z.exactOptional(z.boolean()),
    path: z.exactOptional(z.string()),
  }),
  z.object({ op: literal('commit-detail'), rev: z.string() }),
  z.object({
    op: literal('compare'),
    left: z.string().min(1),
    right: z.string().min(1),
    limit: z.int().min(1),
  }),
  z.object({
    op: literal('blame'),
    path: z.string().min(1),
    rev: z.exactOptional(z.string().min(1)),
  }),
  z.object({ op: literal('commit-patch'), rev: z.string() }),
  z.object({ op: literal('pending-operation'), ref: z.enum(PENDING_REFS) }),
  z.object({ op: literal('add'), paths: z.readonly(z.array(z.string())) }),
  z.object({ op: literal('unstage'), paths: z.readonly(z.array(z.string())) }),
  // The message may be empty only when amending; the core is what refuses an empty message
  // for an ordinary commit, so there is one guard rather than two that can disagree.
  z.object({
    op: literal('commit'),
    message: z.string(),
    body: z.exactOptional(z.string()),
    amend: z.exactOptional(z.boolean()),
  }),
  z.object({ op: literal('branch-create'), name: z.string(), start: z.exactOptional(z.string()) }),
  z.object({ op: literal('branch-rename'), name: z.string(), to: z.string() }),
  z.object({ op: literal('checkout'), ref: z.string(), detach: z.exactOptional(z.boolean()) }),
  z.object({ op: literal('tag-create'), name: z.string(), rev: z.string() }),
  z.object({ op: literal('tag-delete'), name: z.string() }),
  z.object({ op: literal('merge'), ref: z.string() }),
  z.object({ op: literal('merge-abort') }),
  z.object({ op: literal('reset-soft'), rev: z.string().min(1) }),
  z.object({
    op: literal('regenerate-conflict'),
    paths: z.readonly(z.array(z.string())),
  }),
  z.object({
    op: literal('conflict-side'),
    side: z.enum(['base', 'ours', 'theirs']),
    path: z.string().min(1),
  }),
  z.object({
    op: literal('take-side'),
    side: z.enum(['ours', 'theirs']),
    paths: z.readonly(z.array(z.string())),
  }),
  z.object({
    op: literal('resolve-file'),
    path: z.string().min(1),
    content: z.string(),
  }),
  z.object({
    op: literal('resolve-conflict'),
    path: z.string().min(1),
    region: z.int().min(0),
    take: z.enum(['ours', 'theirs', 'both', 'custom']),
    content: z.exactOptional(z.string()),
  }),
  z.object({ op: literal('stash-list') }),
  z.object({ op: literal('stash-apply'), selector: z.string().min(1) }),
  z.object({
    op: literal('stash-pop'),
    selector: z.exactOptional(z.string().min(1)),
  }),
  z.object({ op: literal('stash-drop'), selector: z.string().min(1) }),
  // The renderer reads a stash's patch through its own channel, and this is here because the
  // schema has to cover the command union: the app types a quick command as `GitCommand` and
  // hands it to this shape, so a member missing here is a compile error there.
  z.object({ op: literal('stash-show'), selector: z.string().min(1) }),
  z.object({ op: literal('worktree-list') }),
  z.object({
    op: literal('worktree-add'),
    path: z.string().min(1),
    branch: z.exactOptional(z.string().min(1)),
  }),
  z.object({
    op: literal('worktree-remove'),
    path: z.string().min(1),
    force: z.exactOptional(z.boolean()),
  }),
  z.object({ op: literal('stash-push'), message: z.exactOptional(z.string()) }),
  z.object({ op: literal('branch-delete'), name: z.string(), force: z.exactOptional(z.boolean()) }),
  z.object({ op: literal('fetch'), remote: z.exactOptional(z.string()) }),
  z.object({ op: literal('remote-list') }),
  z.object({ op: literal('identity') }),
  z.object({
    op: literal('credential-fill'),
    request: z.object({
      protocol: z.string().min(1),
      host: z.string().min(1),
      path: z.exactOptional(z.string()),
      username: z.exactOptional(z.string()),
    }),
  }),
  z.object({ op: literal('remote-add'), name: z.string().min(1), url: z.string().min(1) }),
  z.object({ op: literal('remote-remove'), name: z.string().min(1) }),
  z.object({
    op: literal('remote-rename'),
    name: z.string().min(1),
    to: z.string().min(1),
  }),
  z.object({ op: literal('remote-set-url'), name: z.string().min(1), url: z.string().min(1) }),
  z.object({ op: literal('pull') }),
  z.object({
    op: literal('push'),
    remote: z.string(),
    branch: z.string(),
    force: z.exactOptional(z.boolean()),
  }),
  z.object({ op: literal('reset-hard'), rev: z.string() }),
  z.object({
    op: literal('clean'),
    paths: z.exactOptional(z.readonly(z.array(z.string()))),
  }),
  z.object({
    op: literal('discard-hunk'),
    path: z.string().min(1),
    hunk: z.int().min(0),
  }),
  z.object({ op: literal('discard'), paths: z.readonly(z.array(z.string())) }),
]);

/**
 * Compile-time proof that the IPC schema still describes the core's command union: if an
 * operation is added to `GitCommand` and not here, this line stops compiling.
 */
type SchemaCoversCore = z.infer<typeof gitCommandSchema> extends GitCommand ? true : never;
const _schemaCoversCore: SchemaCoversCore = true;
void _schemaCoversCore;

/**
 * What the repository looked like before an operation, which is what makes an undo possible at all.
 *
 * The window sends it rather than the main process reading it, because the window already holds it —
 * the last status read and the last refs read are in memory — and because a second read would be a
 * state that could have moved between the two.
 */
export const beforeStateSchema = z.object({
  head: z.string().nullable(),
  branch: z.string().nullable(),
  targets: z.record(z.string(), z.string()),
});

export const runRequestSchema = z.object({
  path: z.string().min(1),
  command: gitCommandSchema,
  confirm: z.exactOptional(z.string().min(1)),
  before: z.exactOptional(beforeStateSchema),
});

export type RunRequest = z.infer<typeof runRequestSchema>;

/**
 * A revision is untrusted input from a web page until it is parsed here: `rev` cannot be
 * empty, because an empty revision reaches git as a different question, not a smaller one.
 */
export const commitReadRequestSchema = z.object({
  path: z.string().min(1),
  rev: z.string().min(1),
});

export type CommitReadRequest = z.infer<typeof commitReadRequestSchema>;

const FILE_STATUSES = [
  'unmodified',
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'unmerged',
  'untracked',
  'ignored',
  'unknown',
] as const;

const fileStatusSchema = z.enum(FILE_STATUSES);

const ORDINARY_FIELDS = {
  path: z.string(),
  index: fileStatusSchema,
  worktree: fileStatusSchema,
  submodule: z.nullable(z.string()),
  raw: z.string(),
} as const;

/**
 * What arrives over the `status` channel. Parsed in the main process before it crosses the
 * boundary, because the renderer is a web page and a shape it was not expecting is how a
 * screen ends up rendering `undefined` where a state should be.
 */
export const repoStateSchema = z.object({
  head: z.discriminatedUnion('kind', [
    z.object({
      kind: literal('branch'),
      name: z.string(),
      oid: z.string(),
      upstream: z.string().nullable(),
      ahead: z.number(),
      behind: z.number(),
    }),
    z.object({ kind: literal('detached'), oid: z.string() }),
    z.object({ kind: literal('unborn'), name: z.string().nullable() }),
  ]),
  entries: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: literal('ordinary'), ...ORDINARY_FIELDS }),
      z.object({
        kind: literal('renamed'),
        ...ORDINARY_FIELDS,
        origPath: z.exactOptional(z.string()),
      }),
      z.object({ kind: literal('unmerged'), ...ORDINARY_FIELDS }),
      z.object({
        kind: literal('untracked'),
        path: z.string(),
        submodule: z.null(),
        raw: z.string(),
      }),
      z.object({
        kind: literal('ignored'),
        path: z.string(),
        submodule: z.null(),
        raw: z.string(),
      }),
    ]),
  ),
  headers: z.record(z.string(), z.string()),
  // Not a flag on an error: a repository in the middle of an operation is a state, and it is
  // one the screen has a design for.
  pending: z.enum(PENDING_OPERATIONS).nullable(),
});

/**
 * Compile-time proof that the schema above still describes the core's `RepoState`: if the core
 * gains a state — a fourth pending operation, a new head kind — this stops compiling rather
 * than the renderer quietly receiving a value it cannot name.
 */
type StateSchemaCoversCore = z.infer<typeof repoStateSchema> extends RepoState ? true : never;
const _stateSchemaCoversCore: StateSchemaCoversCore = true;
void _stateSchemaCoversCore;

/**
 * The path a web page names on this channel. A string, validated before `openRepo` is
 * allowed to look at it — the renderer is untrusted, and "" is a question with no answer.
 */
export const statusPathSchema = z.string().min(1);

export const statusPayloadSchema = z.object({
  root: z.string().min(1),
  state: repoStateSchema,
});

export const stashRequestSchema = z.object({ path: z.string().min(1) });

/**
 * Who commits are made as, and where each part of it comes from.
 *
 * The window shows the three in force with the file each was read from: a repository with two
 * identities configured is the case this is for, and the interesting half is which file won.
 */
export interface IdentityPayload {
  readonly root: string;
  readonly identity: {
    readonly name: {
      readonly value: string;
      readonly scope: string;
      readonly origin: string;
    } | null;
    readonly email: {
      readonly value: string;
      readonly scope: string;
      readonly origin: string;
    } | null;
    readonly signingKey: {
      readonly value: string;
      readonly scope: string;
      readonly origin: string;
    } | null;
  };
}

/**
 * The remotes this repository is configured with: a name and the two URLs it points at.
 *
 * Not the same list as the remote *branches* the panel shows: a remote with nothing fetched from it
 * has no branches and is still a remote, and the question this answers is what the config says.
 */
export interface RemotesPayload {
  readonly root: string;
  readonly remotes: readonly {
    readonly name: string;
    readonly fetchUrl: string | null;
    readonly pushUrl: string | null;
  }[];
}

export interface WorktreesPayload {
  readonly root: string;
  readonly worktrees: readonly {
    readonly path: string;
    readonly head: string | null;
    readonly branch: string | null;
    readonly bare: boolean;
    readonly detached: boolean;
    readonly locked: string | null;
    readonly prunable: string | null;
  }[];
}

export const stashPatchRequestSchema = z.object({
  path: z.string().min(1),
  selector: z.string().min(1),
});

export const conflictRegionRequestSchema = z.object({
  path: z.string().min(1),
  file: z.string().min(1),
});

export interface ConflictRegionsPayload {
  readonly root: string;
  readonly path: string;
  readonly regions: readonly {
    readonly start: number;
    readonly end: number;
    readonly ours: readonly string[];
    readonly theirs: readonly string[];
  }[];
}

export const conflictSideRequestSchema = z.object({
  /** The repository. `file` is the conflicted path inside it, the way every other channel names a
   *  repository and something in it. */
  path: z.string().min(1),
  file: z.string().min(1),
  side: z.enum(['base', 'ours', 'theirs']),
});

export const stashPayloadSchema = z.object({
  root: z.string().min(1),
  stashes: z.array(
    z.object({
      selector: z.string(),
      oid: z.string(),
      committedAt: z.number(),
      subject: z.string(),
      raw: z.string(),
    }),
  ),
});

export interface ConflictSidePayload {
  readonly root: string;
  readonly side: 'base' | 'ours' | 'theirs';
  readonly path: string;
  readonly content: string;
}

export interface StashPatchPayload {
  readonly root: string;
  readonly files: readonly DiffFile[];
}

export interface StashPayload {
  readonly root: string;
  readonly stashes: readonly {
    readonly selector: string;
    readonly oid: string;
    readonly committedAt: number;
    readonly subject: string;
    readonly raw: string;
  }[];
}

/**
 * What the app remembers between runs. Three fields, all of them decisions a person made by
 * opening something or setting a hotkey; nothing is stored that they did not do.
 */
export interface PersistedState {
  readonly recents: readonly string[];
  readonly last: string | null;
  readonly hotkey: string | null;
}

export const persistedStateSchema = z.object({
  recents: z.array(z.string()),
  last: z.string().nullable(),
  hotkey: z.string().nullable(),
});

export const rememberRequestSchema = z.object({ path: z.string().min(1) });

/** A repository that cannot be read any more, so that it stops being reopened on every launch. */
export const forgetLastRequestSchema = z.object({ path: z.string().min(1) });
export const setHotkeyRequestSchema = z.object({ hotkey: z.string().min(1) });

export interface GraphPayload {
  readonly root: string;
  readonly data: GraphData;
}

export interface StatusPayload {
  readonly root: string;
  readonly state: RepoState;
}

export interface RefsPayload {
  readonly root: string;
  readonly refs: readonly Ref[];
}

export interface DiffPayload {
  readonly root: string;
  readonly files: readonly DiffFile[];
}

/**
 * The blame of one file: one record per line, in the file's own order.
 *
 * The lines are the file's, not the commits': a line that is only in the working tree comes back
 * against the all-zero sha with `Not Committed Yet` as its author, and the pane shows that as a line
 * with nowhere to jump rather than as a commit that does not exist.
 */
export interface BlamePayload {
  readonly root: string;
  readonly file: string;
  readonly lines: readonly {
    readonly line: number;
    readonly originalLine: number;
    readonly oid: string;
    readonly summary: string;
    readonly author: string;
    readonly authorMail: string;
    readonly authorTime: number;
    readonly content: string;
    readonly boundary: boolean;
    readonly previous: string | null;
  }[];
}

export const blameRequestSchema = z.object({
  path: z.string().min(1),
  file: z.string().min(1),
  rev: z.exactOptional(z.string().min(1)),
});

export type BlameRequest = z.infer<typeof blameRequestSchema>;

/**
 * A working-tree diff is one of three questions. `cached` picks the index-as-base form, and
 * leaving `rev` out picks the index-as-other-side form; both booleans and the revision are
 * validated here even though the caller controls the flag, because the renderer is a web page.
 */
export const diffRequestSchema = z.object({
  path: z.string().min(1),
  rev: z.exactOptional(z.string().min(1)),
  cached: z.exactOptional(z.boolean()),
});

export type DiffRequest = z.infer<typeof diffRequestSchema>;

export interface RunPayload {
  readonly op: string;
  readonly risk: string;
  readonly argv: readonly string[];
  /**
   * The command that puts the repository back, or `null` when there is nothing to undo with.
   *
   * A command rather than a line of text, because the window runs it: `argv` is for showing and
   * copying, `risk` is what decides whether running it goes through the confirmation sheet — the
   * reverse of a `reset --hard` is another one.
   */
  readonly reverse: {
    readonly command: GitCommand;
    readonly argv: readonly string[];
    readonly risk: string;
  } | null;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /**
   * What to do about the failure, when the command failed for one of the network reasons the core
   * knows — an SSH key that is not loaded, a token without the right scope, a machine that cannot
   * reach the host. `null` for every ordinary failure: a merge conflict needs no advice.
   */
  readonly diagnosis: {
    readonly failure: string;
    readonly what: string;
    readonly whatToDo: string;
  } | null;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string; readonly kind: string };

/**
 * The renderer's whole view of the outside world. Kept deliberately narrow: there is no
 * `invoke(channel, anything)` escape hatch, so the preload script is a whitelist and not
 * a pipe.
 */
export interface OrbitreeApi {
  readonly open: (path: string) => Promise<Result<{ root: string }>>;
  readonly status: (path: string) => Promise<Result<StatusPayload>>;
  readonly graph: (
    path: string,
    request: {
      limit: number;
      all?: boolean;
      rev?: string;
      /** One file, for its own history: the commits that touched it, in the graph's own shape. */
      file?: string;
      hide?: readonly string[];
    },
  ) => Promise<Result<GraphPayload>>;
  readonly refs: (path: string) => Promise<Result<RefsPayload>>;
  readonly diff: (
    path: string,
    request: { rev?: string; cached?: boolean },
  ) => Promise<Result<DiffPayload>>;
  readonly readCommit: (path: string, rev: string) => Promise<Result<CommitData>>;
  readonly readStash: (path: string) => Promise<Result<StashPayload>>;
  /** Every working directory this repository has checked out, `stashRequestSchema`-shaped. */
  readonly readWorktrees: (path: string) => Promise<Result<WorktreesPayload>>;
  /** The name, email and signing key commits are made with, and the file each came from. */
  readonly readIdentity: (path: string) => Promise<Result<IdentityPayload>>;
  /** The remotes this repository is configured with, as the config has them. */
  readonly readRemotes: (path: string) => Promise<Result<RemotesPayload>>;
  /** Who wrote each line of one file, and in which commit. */
  readonly readBlame: (request: BlameRequest) => Promise<Result<BlamePayload>>;
  /** One stash's patch, read on demand: a list of stashes is cheap, their patches are not. */
  readonly readStashPatch: (request: {
    readonly path: string;
    readonly selector: string;
  }) => Promise<Result<StashPatchPayload>>;
  /** One side of a conflicted path, read from the index stage that holds it. */
  readonly readConflictSide: (request: {
    readonly path: string;
    readonly file: string;
    readonly side: 'base' | 'ours' | 'theirs';
  }) => Promise<Result<ConflictSidePayload>>;
  /** The conflict regions of one path, counted from 0 in the order the markers appear. */
  readonly readConflictRegions: (request: {
    readonly path: string;
    readonly file: string;
  }) => Promise<Result<ConflictRegionsPayload>>;
  readonly run: (request: RunRequest) => Promise<Result<RunPayload>>;
  readonly pickDirectory: () => Promise<string | null>;
  readonly togglePopup: () => Promise<Result<boolean>>;
  readonly onShown: (callback: () => void) => void;
  /**
   * Called as git reports progress, while a remote command runs.
   *
   * An event rather than a field of the result, because a fetch that takes a minute is the case it
   * exists for: the result arrives when there is nothing left to report.
   */
  readonly onRunProgress: (callback: (progress: Progress) => void) => void;
  readonly showWindow: () => Promise<Result<boolean>>;
  readonly readState: () => Promise<Result<PersistedState>>;
  readonly remember: (path: string) => Promise<Result<PersistedState>>;
  readonly setHotkey: (hotkey: string) => Promise<Result<PersistedState>>;
  readonly forgetLast: (path: string) => Promise<Result<PersistedState>>;
}

/** A button in the Quick Commands bar. Data, not code, so a user can edit the list. */
export interface QuickCommand {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly command: GitCommand;
  /** Destructive commands ask for a reason before they are allowed to run. */
  readonly danger: boolean;
}

export const DEFAULT_QUICK_COMMANDS: readonly QuickCommand[] = [
  { id: 'fetch', label: 'Fetch', hint: 'fetch --prune', command: { op: 'fetch' }, danger: false },
  { id: 'pull', label: 'Pull', hint: 'pull --ff-only', command: { op: 'pull' }, danger: false },
  {
    id: 'push',
    label: 'Push',
    hint: 'push the current branch',
    command: { op: 'push', remote: 'origin', branch: 'HEAD' },
    danger: false,
  },
  { id: 'stash', label: 'Stash', hint: 'stash push', command: { op: 'stash-push' }, danger: false },
  { id: 'pop', label: 'Unstash', hint: 'stash pop', command: { op: 'stash-pop' }, danger: false },
  {
    id: 'clean',
    label: 'Clean',
    hint: 'clean -fd (untracked files)',
    command: { op: 'clean' },
    danger: true,
  },
  {
    id: 'reset-hard',
    label: 'Reset --hard',
    hint: 'discard every uncommitted change',
    command: { op: 'reset-hard', rev: 'HEAD' },
    danger: true,
  },
];
