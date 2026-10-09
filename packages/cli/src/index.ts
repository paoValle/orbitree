#!/usr/bin/env node
/**
 * `orbitree` — the CLI.
 *
 * Two rules, both for the benefit of whoever drives this from a script or an agent:
 *   1. `--json` prints exactly one JSON object on stdout and nothing else;
 *   2. every mutation of the repository is refused unless it is a `--dry-run` or carries
 *      a `--confirm "<reason>"`.
 *
 * There is no second implementation under here. Every command calls `@orbitree/core` —
 * the same functions the desktop app calls, which is what makes the two agree by
 * construction rather than by maintenance.
 */
import {
  APP_NAME,
  type CommitDetail,
  ConfirmationRequiredError,
  execute,
  type GitCommand,
  type GitFailedError,
  type GitNotFoundError,
  type GraphData,
  gitVersion,
  InvalidArgumentError,
  MINIMUM_GIT_VERSION,
  meetsMinimumGitVersion,
  NotARepositoryError,
  openRepo,
  type Ref,
  type RepoHandle,
  type RepoState,
  readCommit,
  readDiff,
  readGraph,
  readRefs,
  readStatus,
  riskOf,
  SCHEMA_VERSION,
  toArgv,
} from '@orbitree/core';
import { Command } from 'commander';

/** Exit codes are part of the contract: `docs/AGENT-CLI.md` documents them. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notARepository: 3,
  gitFailed: 4,
  confirmationRequired: 5,
} as const;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const defaultIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

function emit<T>(
  io: CliIo,
  json: boolean,
  command: string,
  data: T,
  human: (data: T) => string,
): void {
  if (json) {
    io.out(JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, ok: true, data }));
  } else {
    io.out(human(data));
  }
}

function fail(io: CliIo, json: boolean, command: string, error: unknown): number {
  const known = error instanceof Error ? error : new Error(String(error));
  const kind =
    known instanceof NotARepositoryError
      ? 'not-a-repository'
      : known.name === 'GitNotFoundError'
        ? 'git-not-found'
        : known instanceof ConfirmationRequiredError
          ? 'confirmation-required'
          : known.name === 'GitFailedError'
            ? 'git-failed'
            : known instanceof InvalidArgumentError
              ? 'invalid-argument'
              : 'error';
  const code =
    kind === 'not-a-repository'
      ? EXIT.notARepository
      : kind === 'confirmation-required'
        ? EXIT.confirmationRequired
        : kind === 'git-failed'
          ? EXIT.gitFailed
          : kind === 'invalid-argument' || kind === 'git-not-found'
            ? EXIT.usage
            : EXIT.error;
  if (json) {
    io.out(
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        command,
        ok: false,
        error: { kind, message: known.message },
      }),
    );
  } else {
    io.err(`${APP_NAME}: ${known.message}`);
  }
  return code;
}

export interface BuildOptions {
  /** Injectable clock, so a test can assert the confirmation timestamp. */
  readonly now?: () => string;
}

export function buildProgram(io: CliIo = defaultIo, options: BuildOptions = {}): Command {
  const program = new Command();
  program
    .name(APP_NAME)
    .description('A local-first Git client. Every command here is also a button in the app.')
    .version('0.0.0', '-v, --version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.out(text.replace(/\n$/, '')),
      writeErr: (text) => io.err(text.replace(/\n$/, '')),
    });

  program
    .command('status')
    .description('the working tree: branch, ahead/behind, staged, unstaged, untracked')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { json?: boolean }) => {
      const repo = await openRepo(path);
      const state = await readStatus(repo);
      emit(io, opts.json === true, 'status', { root: repo.root, ...state }, (data) =>
        describeStatus(repo.root, data),
      );
    });

  program
    .command('graph')
    .description('the commit graph: commits, lanes and edges')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .option('--limit <n>', 'how many commits to read', '200')
    .option('--all', 'include every ref, not only the current branch')
    .option('--rev <rev>', 'the revision whose history to read, instead of HEAD')
    .option('--refs', 'include the ref list in the output (implied by --json)')
    .action(
      async (
        path: string,
        opts: { json?: boolean; limit: string; all?: boolean; rev?: string; refs?: boolean },
      ) => {
        const limit = Number.parseInt(opts.limit, 10);
        const repo = await openRepo(path);
        const graph = await readGraph(repo, {
          limit,
          ...(opts.all === true ? { all: true } : {}),
          ...(opts.rev === undefined ? {} : { rev: opts.rev }),
        });
        const includeRefs = opts.json === true || opts.refs === true;
        emit(
          io,
          opts.json === true,
          'graph',
          {
            root: repo.root,
            // Which history was actually read: a caller that sees `rev: "HEAD"` would
            // believe it got one branch's history when `--all` was used.
            all: opts.all === true,
            rev: opts.all === true ? null : (opts.rev ?? 'HEAD'),
            total: graph.total,
            truncated: graph.truncated,
            commits: graph.commits,
            rows: graph.layout.rows.map((row) => ({
              hash: row.commit.hash,
              subject: row.commit.subject,
              author: row.commit.author.name,
              committedAt: row.commit.committedAt,
              lane: row.lane,
              through: row.through,
              incoming: row.incoming,
              outgoing: row.outgoing,
            })),
            edges: graph.layout.edges,
            laneCount: graph.layout.laneCount,
            ...(includeRefs ? { refs: graph.refs } : {}),
          },
          (data) =>
            `${describeWindow(data.rows.length, graph.total, graph.truncated, data.laneCount)}\n${describeGraph(
              data.rows,
              graph.refsByOid,
              includeRefs ? graph.refs : [],
            )}`,
        );
      },
    );

  program
    .command('refs')
    .description('every branch, tag and remote ref')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { json?: boolean }) => {
      const repo = await openRepo(path);
      const refs = await readRefs(repo);
      emit(io, opts.json === true, 'refs', { root: repo.root, refs }, (data) =>
        describeRefs(data.refs),
      );
    });

  program
    .command('diff')
    .description('a patch: the changes between a revision and the working tree')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--rev <rev>', 'the revision to diff against', 'HEAD')
    .option('--path <path>', 'only report changes under this path')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { rev: string; path?: string; json?: boolean }) => {
      const repo = await openRepo(path);
      const files = await readDiff(repo, {
        rev: opts.rev,
        ...(opts.path === undefined ? {} : { path: opts.path }),
      });
      emit(io, opts.json === true, 'diff', { root: repo.root, rev: opts.rev, files }, (data) =>
        data.files.map((file) => file.raw).join(''),
      );
    });

  program
    .command('show')
    .description('one commit: its metadata and the patch it introduced')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--rev <rev>', 'the commit to show', 'HEAD')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { rev: string; json?: boolean }) => {
      const repo = await openRepo(path);
      const data = await readCommit(repo, { rev: opts.rev });
      emit(
        io,
        opts.json === true,
        'show',
        {
          root: repo.root,
          rev: opts.rev,
          against: data.against,
          commit: data.commit,
          files: data.files,
        },
        (output) =>
          `${describeCommit(output.commit)}\n${output.files.map((file) => file.raw).join('')}`,
      );
    });

  program
    .command('ops')
    .description('the guarded operations, with their risk level and the argv they produce')
    .option('--json', 'one JSON object on stdout')
    .action((opts: { json?: boolean }) => {
      const rows = OP_EXAMPLES.map((command) => ({
        op: command.op,
        risk: riskOf(command),
        argv: toArgv(command),
      }));
      emit(io, opts.json === true, 'ops', rows, (data) =>
        data
          .map((row) => `${row.risk.padEnd(12)} ${row.op.padEnd(16)} git ${row.argv.join(' ')}`)
          .join('\n'),
      );
    });

  program
    .command('run')
    .description('run one guarded operation — the same command the app builds')
    .argument('[path]', 'a path inside the repository', '.')
    .requiredOption('--op <op>', 'the operation name, as listed by `orbitree ops`')
    .option('--arg <value...>', 'arguments for the operation, in the order `ops` shows them')
    .option('--message <text>', 'the commit message', '')
    .option('--dry-run', 'print the argv and change nothing')
    .option('--confirm <reason>', 'required for a destructive operation')
    .option('--json', 'one JSON object on stdout')
    .action(
      async (
        path: string,
        opts: {
          op: string;
          arg?: string[];
          message: string;
          dryRun?: boolean;
          confirm?: string;
          json?: boolean;
        },
      ) => {
        const command = commandFrom(opts.op, opts.arg ?? [], opts.message);
        const repo = await openRepo(path);
        const result = await execute(command, {
          cwd: repo.root,
          ...(opts.confirm === undefined
            ? {}
            : {
                confirmation: {
                  confirmedBy: 'cli',
                  reason: opts.confirm,
                  at: (options.now ?? (() => new Date().toISOString()))(),
                },
              }),
          ...(opts.dryRun === true ? { dryRun: true } : {}),
        });
        emit(
          io,
          opts.json === true,
          'run',
          {
            op: command.op,
            risk: riskOf(command),
            argv: result.argv,
            dryRun: opts.dryRun === true,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          (data) =>
            data.dryRun
              ? `would run: git ${data.argv.join(' ')}`
              : `git ${data.argv.join(' ')}\n${data.stdout}`.trimEnd(),
        );
      },
    );

  program
    .command('doctor')
    .description('what this machine has, and whether it is enough')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { json?: boolean }) => {
      const version = await gitVersion(process.cwd());
      let repoRoot: string | null = null;
      let repoError: string | null = null;
      try {
        repoRoot = (await openRepo(path)).root;
      } catch (error) {
        repoError = error instanceof Error ? error.message : String(error);
      }
      const report = {
        app: APP_NAME,
        schemaVersion: SCHEMA_VERSION,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        git: version,
        minimumGit: MINIMUM_GIT_VERSION,
        gitIsNewEnough: meetsMinimumGitVersion(version),
        repoRoot,
        repoError,
      };
      emit(io, opts.json === true, 'doctor', report, (data) =>
        Object.entries(data)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join('\n'),
      );
    });

  program
    .command('schema')
    .description('the JSON envelope every command prints, for whoever is parsing it')
    .action(() => {
      io.out(
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSION,
            envelope: {
              schemaVersion: 'number — bumped when the shape of `data` changes',
              command: 'string — the command that produced this object',
              ok: 'boolean',
              data: 'present when ok is true',
              error: 'present when ok is false: { kind, message }',
            },
            errorKinds: [
              'not-a-repository',
              'git-not-found',
              'git-failed',
              'confirmation-required',
              'invalid-argument',
              'error',
            ],
            exitCodes: EXIT,
          },
          null,
          2,
        ),
      );
    });

  return program;
}

/** One example per operation: the list `orbitree ops` prints and the tests iterate. */
export const OP_EXAMPLES: readonly GitCommand[] = [
  { op: 'status' },
  { op: 'graph', limit: 50 },
  { op: 'refs' },
  { op: 'diff', rev: 'HEAD' },
  { op: 'commit-detail', rev: 'HEAD' },
  { op: 'commit-patch', rev: 'HEAD' },
  { op: 'add', paths: ['file.txt'] },
  { op: 'unstage', paths: ['file.txt'] },
  { op: 'commit', message: 'a message' },
  { op: 'branch-create', name: 'feature' },
  { op: 'checkout', ref: 'main' },
  { op: 'tag-create', name: 'v1.0.0', rev: 'HEAD' },
  { op: 'merge', ref: 'feature' },
  { op: 'stash-push' },
  { op: 'stash-pop' },
  { op: 'branch-delete', name: 'feature' },
  { op: 'fetch' },
  { op: 'pull' },
  { op: 'push', remote: 'origin', branch: 'main' },
  { op: 'reset-hard', rev: 'HEAD~1' },
  { op: 'clean' },
  { op: 'discard', paths: ['file.txt'] },
];

function commandFrom(op: string, args: readonly string[], message: string): GitCommand {
  switch (op) {
    case 'add':
      return { op: 'add', paths: [...args] };
    case 'unstage':
      return { op: 'unstage', paths: [...args] };
    case 'discard':
      return { op: 'discard', paths: [...args] };
    case 'commit':
      return { op: 'commit', message };
    case 'fetch':
      return args[0] === undefined ? { op: 'fetch' } : { op: 'fetch', remote: args[0] };
    case 'pull':
      return { op: 'pull' };
    case 'push': {
      const [remote, branch, flag] = args;
      if (remote === undefined || branch === undefined) {
        throw new InvalidArgumentError('push needs a remote and a branch: --arg origin --arg main');
      }
      return { op: 'push', remote, branch, ...(flag === 'force' ? { force: true } : {}) };
    }
    case 'reset-hard':
      return { op: 'reset-hard', rev: args[0] ?? 'HEAD' };
    case 'clean':
      return { op: 'clean' };
    case 'branch-create':
      return args[0] === undefined
        ? (() => {
            throw new InvalidArgumentError('branch-create needs a name');
          })()
        : { op: 'branch-create', name: args[0] };
    case 'branch-delete':
      return args[0] === undefined
        ? (() => {
            throw new InvalidArgumentError('branch-delete needs a name');
          })()
        : { op: 'branch-delete', name: args[0], ...(args[1] === 'force' ? { force: true } : {}) };
    case 'checkout':
      return args[0] === undefined
        ? (() => {
            throw new InvalidArgumentError('checkout needs a ref');
          })()
        : { op: 'checkout', ref: args[0] };
    case 'merge':
      return args[0] === undefined
        ? (() => {
            throw new InvalidArgumentError('merge needs a ref');
          })()
        : { op: 'merge', ref: args[0] };
    case 'stash-push':
      return { op: 'stash-push' };
    case 'stash-pop':
      return { op: 'stash-pop' };
    case 'diff':
      return { op: 'diff', rev: args[0] ?? 'HEAD' };
    case 'commit-detail':
      return { op: 'commit-detail', rev: args[0] ?? 'HEAD' };
    case 'commit-patch':
      return { op: 'commit-patch', rev: args[0] ?? 'HEAD' };
    case 'tag-create':
      return args[0] === undefined
        ? (() => {
            throw new InvalidArgumentError('tag-create needs a name');
          })()
        : { op: 'tag-create', name: args[0], rev: args[1] ?? 'HEAD' };
    default:
      throw new InvalidArgumentError(
        `unknown op "${op}"; run \`orbitree ops\` for the list, or use a typed command`,
      );
  }
}

function describeStatus(root: string, state: RepoState): string {
  const lines = [root];
  if (state.head.kind === 'branch') {
    const tracking =
      state.head.upstream === null
        ? ''
        : ` (${state.head.upstream} ${state.head.ahead}↑ ${state.head.behind}↓)`;
    lines.push(`branch: ${state.head.name}${tracking}`);
  } else if (state.head.kind === 'unborn') {
    lines.push(`branch: ${state.head.name ?? '(unborn)'} — no commits yet`);
  } else {
    lines.push(`detached at ${state.head.oid.slice(0, 7)}`);
  }
  for (const entry of state.entries) {
    if (entry.kind === 'untracked') lines.push(`  ??        ${entry.path}`);
    else if (entry.kind === 'ignored') lines.push(`  !!        ${entry.path}`);
    else if (entry.kind === 'unmerged') lines.push(`  UU        ${entry.path}`);
    else if (entry.kind === 'renamed')
      lines.push(`  R         ${entry.path} <- ${entry.origPath ?? '?'}`);
    else lines.push(`  ${entry.index}${entry.worktree}       ${entry.path}`);
  }
  if (state.entries.length === 0) lines.push('  (clean)');
  return lines.join('\n');
}

function describeCommit(commit: CommitDetail): string {
  const lines = [
    commit.hash,
    `Author: ${commit.author.name} <${commit.author.email}>`,
    `Date:   ${new Date(commit.authoredAt * 1000).toISOString()}`,
    '',
    `    ${commit.subject}`,
  ];
  if (commit.body !== '') {
    lines.push('');
    for (const line of commit.body.split('\n')) lines.push(`    ${line}`);
  }
  return lines.join('\n');
}

function describeWindow(
  shown: number,
  total: number,
  truncated: boolean,
  laneCount: number,
): string {
  const commits = truncated
    ? `${shown} of ${total} commits`
    : `${shown} commit${shown === 1 ? '' : 's'}`;
  return `${commits} · ${laneCount} lane${laneCount === 1 ? '' : 's'}`;
}

function describeGraph(
  rows: readonly { hash: string; subject: string; author: string; lane: number }[],
  refsByOid: ReadonlyMap<string, readonly { shortName: string }[]>,
  refs: readonly Ref[],
): string {
  const headRefs = new Set(refs.filter((ref) => ref.isHead).map((ref) => ref.target));
  const lines = rows.map((row) => {
    const badges = (refsByOid.get(row.hash) ?? []).map((ref) => ref.shortName);
    const flags = `${badges.length === 0 ? '' : ` [${badges.join(', ')}]`}${headRefs.has(row.hash) ? ' <-HEAD' : ''}`;
    return `${row.hash.slice(0, 8)} ${String(row.lane).padStart(2)}${flags} ${row.subject} — ${row.author}`;
  });
  return lines.join('\n');
}

function describeRefs(refs: readonly Ref[]): string {
  return refs
    .map(
      (ref) =>
        `${ref.isHead ? '*' : ' '} ${ref.kind.padEnd(6)} ${ref.shortName} ${ref.target.slice(0, 7)}`,
    )
    .join('\n');
}

export async function main(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return EXIT.ok;
  } catch (error) {
    // `exitOverride` turns `--help` and a bad option into a throw; those are not failures.
    if (isCommanderExit(error)) return error.exitCode === 0 ? EXIT.ok : EXIT.usage;
    return fail(io, argv.includes('--json'), commandNameOf(argv), error);
  }
}

function isCommanderExit(error: unknown): error is { exitCode: number; code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'exitCode' in error &&
    typeof (error as { code: unknown }).code === 'string'
  );
}

function commandNameOf(argv: readonly string[]): string {
  return argv.find((arg) => !arg.startsWith('-')) ?? 'unknown';
}

/** Unused imports are a compile error here, so the types live in one `import type` above. */
export type { GitFailedError, GitNotFoundError, GraphData, RepoHandle };

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
