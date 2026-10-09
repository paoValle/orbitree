/**
 * The contract between the three processes.
 *
 * The renderer is a trust boundary, not an extension of the main process: what arrives over
 * IPC is parsed with these schemas before a single git argument is built. `gitCommandSchema`
 * is asserted to cover `GitCommand` at compile time, so the IPC surface cannot drift away
 * from what the core actually accepts.
 */
import type { CommitData, GitCommand, GraphData, Ref, RepoState } from '@orbitree/core';
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
  Ref,
  RepoState,
} from '@orbitree/core';

export { CHANNELS };

const literal = <T extends string>(value: T): z.ZodLiteral<T> => z.literal(value);

export const gitCommandSchema = z.discriminatedUnion('op', [
  z.object({ op: literal('version') }),
  z.object({ op: literal('repo-root') }),
  z.object({ op: literal('status') }),
  z.object({
    op: literal('graph'),
    limit: z.int().min(1).max(5000),
    all: z.exactOptional(z.boolean()),
  }),
  z.object({ op: literal('refs') }),
  z.object({ op: literal('diff'), rev: z.string(), path: z.exactOptional(z.string()) }),
  z.object({ op: literal('commit-detail'), rev: z.string() }),
  z.object({ op: literal('commit-patch'), rev: z.string() }),
  z.object({ op: literal('add'), paths: z.readonly(z.array(z.string())) }),
  z.object({ op: literal('unstage'), paths: z.readonly(z.array(z.string())) }),
  z.object({
    op: literal('commit'),
    message: z.string().min(1),
    amend: z.exactOptional(z.boolean()),
  }),
  z.object({ op: literal('branch-create'), name: z.string(), start: z.exactOptional(z.string()) }),
  z.object({ op: literal('checkout'), ref: z.string(), detach: z.exactOptional(z.boolean()) }),
  z.object({ op: literal('tag-create'), name: z.string(), rev: z.string() }),
  z.object({ op: literal('merge'), ref: z.string() }),
  z.object({ op: literal('stash-push'), message: z.exactOptional(z.string()) }),
  z.object({ op: literal('stash-pop') }),
  z.object({ op: literal('branch-delete'), name: z.string(), force: z.exactOptional(z.boolean()) }),
  z.object({ op: literal('fetch'), remote: z.exactOptional(z.string()) }),
  z.object({ op: literal('pull') }),
  z.object({
    op: literal('push'),
    remote: z.string(),
    branch: z.string(),
    force: z.exactOptional(z.boolean()),
  }),
  z.object({ op: literal('reset-hard'), rev: z.string() }),
  z.object({ op: literal('clean') }),
  z.object({ op: literal('discard'), paths: z.readonly(z.array(z.string())) }),
]);

/**
 * Compile-time proof that the IPC schema still describes the core's command union: if an
 * operation is added to `GitCommand` and not here, this line stops compiling.
 */
type SchemaCoversCore = z.infer<typeof gitCommandSchema> extends GitCommand ? true : never;
const _schemaCoversCore: SchemaCoversCore = true;
void _schemaCoversCore;

export const runRequestSchema = z.object({
  path: z.string().min(1),
  command: gitCommandSchema,
  confirm: z.exactOptional(z.string().min(1)),
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

export interface RunPayload {
  readonly op: string;
  readonly risk: string;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
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
    request: { limit: number; all: boolean },
  ) => Promise<Result<GraphPayload>>;
  readonly refs: (path: string) => Promise<Result<RefsPayload>>;
  readonly readCommit: (path: string, rev: string) => Promise<Result<CommitData>>;
  readonly run: (request: RunRequest) => Promise<Result<RunPayload>>;
  readonly pickDirectory: () => Promise<string | null>;
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
