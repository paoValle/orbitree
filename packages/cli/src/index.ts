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
import { readFile } from 'node:fs/promises';
import {
  APP_NAME,
  type CommitDetail,
  ConfirmationRequiredError,
  describeProgress,
  diagnoseFailure,
  execute,
  type GitCommand,
  type GitNotFoundError,
  type GraphData,
  gitVersion,
  InvalidArgumentError,
  MINIMUM_GIT_VERSION,
  meetsMinimumGitVersion,
  NotARepositoryError,
  openRepo,
  presetPath,
  type BlameLine,
  type Commit,
  type Comparison,
  type Ref,
  type RepoHandle,
  type Progress,
  type RepoState,
  readBlame,
  readCommit,
  readComparison,
  readDiff,
  readGraph,
  readRefs,
  readCredential,
  readIdentity,
  readRemotes,
  readStash,
  readStatus,
  readWorktrees,
  riskOf,
  SCHEMA_VERSION,
  toArgv,
  type WorkingTreeNode,
  type Worktree,
  type Remote,
  type Identity,
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
    known instanceof NotARepositoryError || known.name === 'PathNotFoundError'
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
    // The history of one file, in the graph's own shape: the commits git says touched it, laid out
    // by the same function that lays out the whole repository.
    .option('--file <path>', 'only the commits that touched this path')
    .option('--grep <pattern>', 'only the commits whose message matches this regular expression')
    .option('--author <text>', 'only the commits authored by a name or address matching this')
    .option('--since <date>', 'only the commits after this date, as git reads a date')
    .option('--until <date>', 'only the commits before this date')
    .option('--mine', 'only the commits authored by the identity in force')
    .option('--refs', 'include the ref list in the output (implied by --json)')
    .option(
      '--hide <ref>',
      'leave the exclusive commits of this name out of the picture (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(
      async (
        path: string,
        opts: {
          json?: boolean;
          limit: string;
          all?: boolean;
          rev?: string;
          file?: string;
          grep?: string;
          author?: string;
          since?: string;
          until?: string;
          mine?: boolean;
          refs?: boolean;
          hide?: string[];
        },
      ) => {
        const limit = Number.parseInt(opts.limit, 10);
        const repo = await openRepo(path);
        // "Only mine" is not a git option: it is `--author` with the address in force, which is the
        // same identity card the window shows. A repository nobody configured a name in has no address
        // to search by, and saying so is better than silently searching for nothing.
        let author = opts.author;
        if (opts.mine === true) {
          const identity = await readIdentity(repo);
          if (identity.email === null) {
            throw new InvalidArgumentError(
              '--mine needs an identity: this repository has no user.email in force',
            );
          }
          author = identity.email.value;
        }
        const graph = await readGraph(repo, {
          limit,
          ...(opts.all === true ? { all: true } : {}),
          ...(opts.rev === undefined ? {} : { rev: opts.rev }),
          ...(opts.file === undefined ? {} : { path: opts.file }),
          ...(opts.grep === undefined ? {} : { grep: opts.grep }),
          ...(author === undefined ? {} : { author }),
          ...(opts.since === undefined ? {} : { since: opts.since }),
          ...(opts.until === undefined ? {} : { until: opts.until }),
          ...(opts.hide === undefined || opts.hide.length === 0 ? {} : { hide: opts.hide }),
        });
        const includeRefs = opts.json === true || opts.refs === true;
        // A stash is not a ref this product lists, and a row that is one has to say so: its subject
        // is `WIP on main: …` or `On main: …`, which reads as an ordinary commit.
        const stashOf = new Map(graph.stashes.map((stash) => [stash.oid, stash.selector]));
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
            // The working tree, which belongs to the picture: the row above the first commit,
            // joined to the commit HEAD sits on. An agent that reads the graph gets it here
            // rather than having to reconstruct it from a second call.
            wip: graph.wip,
            hidden: graph.hidden,
            commits: graph.commits,
            rows: graph.layout.rows.map((row) => {
              const stash = stashOf.get(row.commit.hash);
              return {
                hash: row.commit.hash,
                subject: row.commit.subject,
                author: row.commit.author.name,
                committedAt: row.commit.committedAt,
                lane: row.lane,
                through: row.through,
                incoming: row.incoming,
                outgoing: row.outgoing,
                ...(stash === undefined ? {} : { stash }),
              };
            }),
            edges: graph.layout.edges,
            laneCount: graph.layout.laneCount,
            ...(includeRefs ? { refs: graph.refs } : {}),
          },
          (data) =>
            `${describeWindow(data.rows.length, graph.total, graph.truncated, data.laneCount)}\n${describeGraph(
              data.rows,
              graph.refsByOid,
              includeRefs ? graph.refs : [],
              graph.wip,
            )}`,
        );
      },
    );

  program
    .command('worktrees')
    .description('every working directory this repository has checked out')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { json?: boolean }) => {
      const repo = await openRepo(path);
      const worktrees = await readWorktrees(repo);
      emit(io, opts.json === true, 'worktrees', { root: repo.root, worktrees }, (data) =>
        describeWorktrees(data.worktrees, repo.root),
      );
    });

  program
    .command('remotes')
    .description('the remotes this repository is configured with, and what they are for')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { json?: boolean }) => {
      const repo = await openRepo(path);
      const remotes = await readRemotes(repo);
      emit(io, opts.json === true, 'remotes', { root: repo.root, remotes }, (data) =>
        describeRemotes(data.remotes),
      );
    });

  program
    .command('credential')
    .description('whether a credential is stored for a host, asked of git’s own helper')
    .argument('[path]', 'a path inside the repository', '.')
    .requiredOption('--host <host>', 'the host to ask about, as a remote URL spells it')
    .option('--protocol <protocol>', 'https, ssh, or whatever the remote uses', 'https')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { host: string; protocol: string; json?: boolean }) => {
      const repo = await openRepo(path);
      const answer = await readCredential(repo, {
        protocol: opts.protocol,
        host: opts.host,
      });
      emit(io, opts.json === true, 'credential', { root: repo.root, ...answer }, (data) =>
        data.available
          ? `${data.username ?? '(no username)'} has a credential for ${opts.protocol}://${opts.host}`
          : `no credential for ${opts.host}: ${data.note ?? 'the helper answered with nothing'}`,
      );
    });

  program
    .command('identity')
    .description('the name, email and signing key commits are made with, and where each comes from')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { json?: boolean }) => {
      const repo = await openRepo(path);
      const identity = await readIdentity(repo);
      emit(io, opts.json === true, 'identity', { root: repo.root, identity }, (data) =>
        describeIdentity(data.identity),
      );
    });

  program
    .command('compare')
    .description('what each side of a fork has that the other does not')
    .argument('[path]', 'a path inside the repository', '.')
    .requiredOption('--left <ref>', 'the first revision')
    .requiredOption('--right <ref>', 'the second one')
    .option('--limit <n>', 'how many commits to read', '500')
    .option('--json', 'one JSON object on stdout')
    .action(
      async (
        path: string,
        opts: { left: string; right: string; limit: string; json?: boolean },
      ) => {
        const repo = await openRepo(path);
        const comparison = await readComparison(repo, {
          left: opts.left,
          right: opts.right,
          limit: Number.parseInt(opts.limit, 10),
        });
        emit(io, opts.json === true, 'compare', { root: repo.root, ...comparison }, (data) =>
          describeComparison(data),
        );
      },
    );

  program
    .command('blame')
    .description('who wrote each line of one file, and in which commit')
    .argument('[path]', 'a path inside the repository', '.')
    // `--file` rather than a second positional: `orbitree blame <path> <file>` cannot tell a file from
    // a path when only one of them is given, and a command that guesses is worse than one that asks.
    .requiredOption('--file <path>', 'the file to blame, relative to the repository root')
    .option('--rev <rev>', 'blame the file as it was at this revision', undefined)
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { file: string; rev?: string; json?: boolean }) => {
      const repo = await openRepo(path);
      const lines = await readBlame(repo, {
        path: opts.file,
        ...(opts.rev === undefined ? {} : { rev: opts.rev }),
      });
      emit(
        io,
        opts.json === true,
        'blame',
        { root: repo.root, file: opts.file, rev: opts.rev ?? null, lines },
        (data) => describeBlame(data.lines),
      );
    });

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
    .description('a patch: staged, unstaged, or the working tree against a revision')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--rev <rev>', 'the revision to diff against', 'HEAD')
    .option('--cached', 'the index against the revision (what is staged)')
    .option('--unstaged', 'the working tree against the index (what is not staged)')
    .option('--path <path>', 'only report changes under this path')
    .option('--json', 'one JSON object on stdout')
    .action(
      async (
        path: string,
        opts: {
          rev: string;
          cached?: boolean;
          unstaged?: boolean;
          path?: string;
          json?: boolean;
        },
      ) => {
        if (opts.cached === true && opts.unstaged === true) {
          throw new InvalidArgumentError(
            '--cached and --unstaged are different questions; pass at most one',
          );
        }
        const repo = await openRepo(path);
        // `--unstaged` is the one mode with no base revision: the index is the base, and the
        // absence of a revision is exactly how `readDiff` asks that question.
        const request =
          opts.unstaged === true
            ? { ...(opts.path === undefined ? {} : { path: opts.path }) }
            : {
                rev: opts.rev,
                ...(opts.cached === true ? { cached: true } : {}),
                ...(opts.path === undefined ? {} : { path: opts.path }),
              };
        const files = await readDiff(repo, request);
        emit(
          io,
          opts.json === true,
          'diff',
          {
            root: repo.root,
            // `null` is a real answer here: the working tree against the index has no
            // revision on either side, and printing `HEAD` would name a commit we never read.
            rev: opts.unstaged === true ? null : opts.rev,
            files,
          },
          (data) => data.files.map((file) => file.raw).join(''),
        );
      },
    );

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
    .command('stash')
    .description('the stashes this repository holds, newest first (read-only)')
    .argument('[path]', 'a path inside the repository', '.')
    .option('--json', 'one JSON object on stdout')
    .action(async (path: string, opts: { json?: boolean }) => {
      const repo = await openRepo(path);
      const stashes = await readStash(repo);
      return emit(io, opts.json === true, 'stash', { root: repo.root, stashes }, (data) =>
        data.stashes.map((entry) => `${entry.selector}  ${entry.subject}`).join('\n'),
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
        await runOperation(
          io,
          path,
          commandFrom(opts.op, opts.arg ?? [], opts.message),
          opts,
          options.now ?? (() => new Date().toISOString()),
          { name: 'run' },
        );
      },
    );

  program
    .command('quick')
    .description('run one of your own commands, by id, from the commands file')
    .argument('[path]', 'a path inside the repository', '.')
    .requiredOption('--id <id>', 'the id of the command in the file')
    .option(
      '--set <name=value>',
      'a value for one of its placeholders (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--commands <file>', 'the commands file, instead of the one this machine uses')
    .option('--dry-run', 'print the argv and change nothing')
    .option('--confirm <reason>', 'required for a destructive command')
    .option('--json', 'one JSON object on stdout')
    .action(
      async (
        path: string,
        opts: {
          id: string;
          set?: string[];
          commands?: string;
          dryRun?: boolean;
          confirm?: string;
          json?: boolean;
        },
      ) => {
        const file = opts.commands ?? presetPath();
        const preset = await readPreset(file);
        const entry = preset.commands.find((candidate) => candidate.id === opts.id);
        if (entry === undefined) {
          const ids = preset.commands.map((candidate) => candidate.id);
          // The ones it does hold, and — when there are any — how many entries were refused, so a file
          // with a typo in it says so instead of looking empty.
          const refused =
            preset.broken.length === 0
              ? ''
              : ` (${preset.broken.length} entr${preset.broken.length === 1 ? 'y' : 'ies'} refused: ${preset.broken.join(', ')})`;
          throw new InvalidArgumentError(
            ids.length === 0
              ? `no command has the id "${opts.id}": ${file} holds none${refused}`
              : `no command has the id "${opts.id}"; ${file} holds ${ids.join(', ')}${refused}`,
          );
        }
        const command = fillCommand(entry.command, valuesOf(opts.set ?? []), entry.id);
        await runOperation(
          io,
          path,
          command,
          opts,
          options.now ?? (() => new Date().toISOString()),
          { name: 'quick', id: entry.id },
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
  { op: 'blame', path: 'packages/core/src/index.ts' },
  { op: 'compare', left: 'main', right: 'next', limit: 100 },
  { op: 'commit-patch', rev: 'HEAD' },
  { op: 'pending-operation', ref: 'MERGE_HEAD' },
  { op: 'add', paths: ['file.txt'] },
  { op: 'unstage', paths: ['file.txt'] },
  { op: 'commit', message: 'a message' },
  { op: 'branch-create', name: 'feature' },
  { op: 'branch-rename', name: 'feature', to: 'feature-2' },
  { op: 'checkout', ref: 'main' },
  { op: 'tag-create', name: 'v1.0.0', rev: 'HEAD' },
  { op: 'tag-delete', name: 'v1.0.0' },
  { op: 'take-side', side: 'ours', paths: ['file.txt'] },
  { op: 'merge-abort' },
  { op: 'reset-soft', rev: 'HEAD~1' },
  { op: 'regenerate-conflict', paths: ['file.txt'] },
  { op: 'conflict-side', side: 'ours', path: 'file.txt' },
  { op: 'discard-hunk', path: 'file.txt', hunk: 0 },
  { op: 'resolve-conflict', path: 'file.txt', region: 0, take: 'ours' },
  { op: 'resolve-file', path: 'file.txt', content: 'the whole file, as it should read' },
  { op: 'merge', ref: 'feature' },
  { op: 'stash-push' },
  { op: 'stash-pop' },
  { op: 'stash-apply', selector: 'stash@{0}' },
  { op: 'stash-show', selector: 'stash@{0}' },
  { op: 'worktree-list' },
  { op: 'worktree-add', path: '/tmp/a-worktree' },
  { op: 'worktree-remove', path: '/tmp/a-worktree' },
  { op: 'stash-drop', selector: 'stash@{0}' },
  { op: 'branch-delete', name: 'feature' },
  { op: 'fetch' },
  { op: 'pull' },
  { op: 'push', remote: 'origin', branch: 'main' },
  { op: 'remote-list' },
  { op: 'identity' },
  { op: 'credential-fill', request: { protocol: 'https', host: 'github.com' } },
  { op: 'remote-add', name: 'origin', url: 'git@example.invalid:x/y.git' },
  { op: 'remote-rename', name: 'origin', to: 'upstream' },
  { op: 'remote-set-url', name: 'origin', url: '../elsewhere' },
  { op: 'remote-remove', name: 'origin' },
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
    case 'discard-hunk': {
      // The path and the hunk number, in that order, as `orbitree ops` lists them. The patch
      // itself is not an argument: it is built from a read of that path, inside the executor.
      const path = args[0];
      const hunk = Number.parseInt(args[1] ?? '', 10);
      if (path === undefined || path === '' || !Number.isInteger(hunk) || hunk < 0) {
        throw new InvalidArgumentError(
          `discard-hunk takes a path and a hunk number, got ${args.join(' ') || 'nothing'}`,
        );
      }
      return { op: 'discard-hunk', path, hunk };
    }
    case 'commit':
      // The body arrives as an argument because `--message` is the summary: the CLI's own flags
      // name the two fields the way the window's box does.
      return { op: 'commit', message, ...(args[0] === undefined ? {} : { body: args[0] }) };
    case 'fetch':
      return args[0] === undefined ? { op: 'fetch' } : { op: 'fetch', remote: args[0] };
    case 'remote-list':
      return { op: 'remote-list' };
    case 'identity':
      return { op: 'identity' };
    case 'credential-fill': {
      const [host, protocol] = args;
      if (host === undefined || host === '') {
        throw new InvalidArgumentError(
          'credential-fill needs a host: --arg github.com [--arg https]',
        );
      }
      return { op: 'credential-fill', request: { protocol: protocol ?? 'https', host } };
    }
    case 'remote-add':
    case 'remote-set-url': {
      const [name, url] = args;
      if (name === undefined || name === '' || url === undefined || url === '') {
        throw new InvalidArgumentError(`${op} needs a name and a URL: --arg origin --arg <url>`);
      }
      return op === 'remote-add'
        ? { op: 'remote-add', name, url }
        : { op: 'remote-set-url', name, url };
    }
    case 'remote-remove':
    case 'remote-rename': {
      const [name, to] = args;
      if (name === undefined || name === '') {
        throw new InvalidArgumentError(`${op} needs a remote name`);
      }
      if (op === 'remote-remove') return { op: 'remote-remove', name };
      if (to === undefined || to === '') {
        throw new InvalidArgumentError('remote-rename needs the remote and its new name');
      }
      return { op: 'remote-rename', name, to };
    }
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
      return args.length === 0 ? { op: 'clean' } : { op: 'clean', paths: [...args] };
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
    case 'branch-rename':
      return args[0] === undefined || args[1] === undefined
        ? (() => {
            throw new InvalidArgumentError('branch-rename needs the branch and its new name');
          })()
        : { op: 'branch-rename', name: args[0], to: args[1] };
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
      return args[0] === undefined ? { op: 'stash-pop' } : { op: 'stash-pop', selector: args[0] };
    // The reads are operations too: `ops` publishes them, so `run` accepts them, which is what
    // makes the list authoritative rather than a description of the mutations.
    case 'status':
      return { op: 'status' };
    case 'refs':
      return { op: 'refs' };
    case 'graph':
      return {
        op: 'graph',
        limit: args[0] === undefined ? 200 : Number.parseInt(args[0], 10),
        ...(args[1] === undefined || args[1] === '' ? {} : { path: args[1] }),
      };
    case 'pending-operation': {
      const ref = args[0];
      if (ref !== 'MERGE_HEAD' && ref !== 'CHERRY_PICK_HEAD' && ref !== 'REBASE_HEAD') {
        throw new InvalidArgumentError(
          'pending-operation takes MERGE_HEAD, CHERRY_PICK_HEAD or REBASE_HEAD',
        );
      }
      return { op: 'pending-operation', ref };
    }

    case 'take-side':
      // The side and then the paths, and at least one path: a side without a path is a question
      // about nothing.
      if ((args[0] !== 'ours' && args[0] !== 'theirs') || args[1] === undefined) {
        throw new InvalidArgumentError('take-side takes ours or theirs, then a path');
      }
      return { op: 'take-side', side: args[0], paths: args.slice(1) };
    case 'merge-abort':
      return { op: 'merge-abort' };
    case 'reset-soft':
      return { op: 'reset-soft', rev: args[0] ?? 'HEAD' };
    case 'regenerate-conflict':
      if (args.length === 0) {
        throw new InvalidArgumentError('regenerate-conflict needs at least one path');
      }
      return { op: 'regenerate-conflict', paths: [...args] };
    case 'conflict-side':
      // A read, but a caller may still ask for it through `run`: it is one of the index stages.
      if (
        (args[0] !== 'base' && args[0] !== 'ours' && args[0] !== 'theirs') ||
        args[1] === undefined
      ) {
        throw new InvalidArgumentError('conflict-side takes base, ours or theirs, then a path');
      }
      return { op: 'conflict-side', side: args[0], path: args[1] };
    case 'worktree-list':
      return { op: 'worktree-list' };
    case 'worktree-add':
    case 'worktree-remove': {
      const where = args[0];
      if (where === undefined || where === '') {
        throw new InvalidArgumentError(`${op} needs a path`);
      }
      return op === 'worktree-add'
        ? { op: 'worktree-add', path: where, ...(args[1] === undefined ? {} : { branch: args[1] }) }
        : { op: 'worktree-remove', path: where, ...(args[1] === 'force' ? { force: true } : {}) };
    }
    case 'resolve-file': {
      const filePath = args[0];
      if (filePath === undefined || filePath === '') {
        throw new InvalidArgumentError('resolve-file takes a path and the text it should hold');
      }
      return { op: 'resolve-file', path: filePath, content: args.slice(1).join('\n') };
    }
    case 'resolve-conflict': {
      const path = args[0];
      const region = Number.parseInt(args[1] ?? '', 10);
      const take = args[2];
      if (path === undefined || path === '' || !Number.isInteger(region) || region < 0) {
        throw new InvalidArgumentError('resolve-conflict takes a path and a region number');
      }
      if (take !== 'ours' && take !== 'theirs' && take !== 'both' && take !== 'custom') {
        throw new InvalidArgumentError(
          'resolve-conflict takes ours, theirs, both or custom as the third argument',
        );
      }
      return {
        op: 'resolve-conflict',
        path,
        region,
        take,
        // Only for `custom`, and only the lines of that one region: what a caller supplies here
        // becomes the *added* lines of a patch whose removals come from the file itself.
        ...(take === 'custom' ? { content: args.slice(3).join('\n') } : {}),
      };
    }
    case 'stash-apply':
    case 'stash-drop':
    case 'stash-show': {
      // The selector, which is `stash@{0}` or anything else git resolves as a stash: this CLI
      // hands it back unchanged, and `assertSafeRef` in the argv is what refuses a hostile one.
      const selector = args[0];
      if (selector === undefined || selector === '') {
        throw new InvalidArgumentError(
          `${op} needs a stash selector, as \`orbitree ops\` lists it`,
        );
      }
      return { op, selector };
    }
    case 'diff':
      return { op: 'diff', rev: args[0] ?? 'HEAD' };
    case 'commit-detail':
      return { op: 'commit-detail', rev: args[0] ?? 'HEAD' };
    case 'compare': {
      const [left, right] = args;
      if (left === undefined || right === undefined) {
        throw new InvalidArgumentError('compare needs two revisions: --arg main --arg feature');
      }
      return {
        op: 'compare',
        left,
        right,
        limit: args[2] === undefined ? 500 : Number.parseInt(args[2], 10),
      };
    }
    case 'blame': {
      const file = args[0];
      if (file === undefined || file === '') {
        throw new InvalidArgumentError('blame needs a file: --arg <path> [--arg <rev>]');
      }
      return { op: 'blame', path: file, ...(args[1] === undefined ? {} : { rev: args[1] }) };
    }
    case 'commit-patch':
      return { op: 'commit-patch', rev: args[0] ?? 'HEAD' };
    case 'tag-create':
      return args[0] === undefined
        ? (() => {
            throw new InvalidArgumentError('tag-create needs a name');
          })()
        : { op: 'tag-create', name: args[0], rev: args[1] ?? 'HEAD' };
    case 'tag-delete':
      return args[0] === undefined
        ? (() => {
            throw new InvalidArgumentError('tag-delete needs a name');
          })()
        : { op: 'tag-delete', name: args[0] };
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
  // The operation under way, said in words before the file list: a reader looking at a
  // conflicted entry needs to know which command is stopped, not only that a file is.
  if (state.pending !== null) lines.push(`${state.pending} in progress`);
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
  rows: readonly {
    hash: string;
    subject: string;
    author: string;
    lane: number;
    stash?: string;
  }[],
  refsByOid: ReadonlyMap<string, readonly { shortName: string }[]>,
  refs: readonly Ref[],
  wip: WorkingTreeNode,
): string {
  const headRefs = new Set(refs.filter((ref) => ref.isHead).map((ref) => ref.target));
  const lines = rows.map((row) => {
    // The stash selector first, because it is what tells this row from a commit that happens to
    // be called `WIP on main: …`.
    const badges = [
      ...(row.stash === undefined ? [] : [row.stash]),
      ...(refsByOid.get(row.hash) ?? []).map((ref) => ref.shortName),
    ];
    const flags = `${badges.length === 0 ? '' : ` [${badges.join(', ')}]`}${headRefs.has(row.hash) ? ' <-HEAD' : ''}`;
    return `${row.hash.slice(0, 8)} ${String(row.lane).padStart(2)}${flags} ${row.subject} — ${row.author}`;
  });
  return [describeWip(wip, rows), ...lines].join('\n');
}

/**
 * The working tree as the first line of the picture, and in the lane of the commit it sits on
 * so that the text and the window say the same thing about where it is.
 */
function describeWip(
  wip: WorkingTreeNode,
  rows: readonly { hash: string; lane: number }[],
): string {
  const waiting = [
    wip.staged === 0 ? null : `${wip.staged} staged`,
    wip.unstaged === 0 ? null : `${wip.unstaged} changed`,
    wip.conflicted === 0 ? null : `${wip.conflicted} conflicted`,
    wip.untracked === 0 ? null : `${wip.untracked} untracked`,
  ].filter((part) => part !== null);
  const lane = rows.find((row) => row.hash === wip.on)?.lane ?? 0;
  const on = wip.on === null ? 'no commit yet' : wip.on.slice(0, 8);
  const state = waiting.length === 0 ? 'clean' : waiting.join(', ');
  // Padded to the width of a hash and the space after it, so the lane column lines up.
  return `${'WIP'.padEnd(9)}${String(lane).padStart(2)} ${state} -> ${on}`;
}

/**
 * The identity, one line per part of it: what it says, and where it came from. A part nobody set is
 * said to be unset rather than left out, because "git will refuse to commit" is an answer a reader
 * needs before they try rather than after.
 */
function describeIdentity(identity: Identity): string {
  const part = (label: string, value: Identity['name']): string =>
    `${label.padEnd(12)} ${value === null ? '(unset)' : `${value.value}  (${value.scope}, ${value.origin})`}`;
  return [
    part('name', identity.name),
    part('email', identity.email),
    part('signing key', identity.signingKey),
  ].join('\n');
}

/**
 * The remotes, one per line: the name, where it fetches from, and where it pushes to when that is a
 * different place. Two URLs on one line because a remote is one thing — the split is git's output
 * format, not its meaning.
 */
function describeRemotes(remotes: readonly Remote[]): string {
  return remotes
    .map((remote) => {
      const fetch = remote.fetchUrl ?? '(no fetch url)';
      const push =
        remote.pushUrl === null || remote.pushUrl === remote.fetchUrl
          ? ''
          : ` push: ${remote.pushUrl}`;
      return `${remote.name.padEnd(16)} ${fetch}${push}`;
    })
    .join('\n');
}

/**
 * The worktrees, one per line, with the one this command was run in marked. The mark is the whole
 * point of the output: the same history in two directories is only useful if you can tell which
 * directory you asked from.
 */
function describeWorktrees(worktrees: readonly Worktree[], here: string): string {
  return worktrees
    .map((worktree) => {
      const mark = worktree.path === here ? '*' : ' ';
      const where = worktree.bare ? 'bare' : (worktree.branch ?? 'detached');
      return `${mark} ${(worktree.head ?? '').slice(0, 8).padEnd(8)} ${where.padEnd(20)} ${worktree.path}`;
    })
    .join('\n');
}

/**
 * Runs one command the way `run` does, whichever surface named it.
 *
 * One implementation, because `run --op` and `quick --id` are two ways of *choosing* a command and not two
 * ways of running one: the argv, the progress, the diagnosis, the exit code and the JSON envelope are the
 * same promises either way, and two copies of this would be two sets of them.
 */
async function runOperation(
  io: CliIo,
  path: string,
  command: GitCommand,
  opts: { dryRun?: boolean; confirm?: string; json?: boolean },
  now: () => string,
  surface: { readonly name: 'run' | 'quick'; readonly id?: string },
): Promise<void> {
  const repo = await openRepo(path);
  // Progress is printed as it arrives rather than with the result: a fetch that takes a minute is the case
  // this exists for, and a line printed at the end would be a report. It goes to stderr, so `--json` is
  // still one object on stdout.
  const reported: Progress[] = [];
  const result = await execute(command, {
    cwd: repo.root,
    onProgress: (progress) => {
      reported.push(progress);
      io.err(describeProgress(progress));
    },
    ...(opts.confirm === undefined
      ? {}
      : {
          confirmation: {
            confirmedBy: 'cli',
            reason: opts.confirm,
            at: now(),
          },
        }),
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  });
  // A failed remote command is a result here rather than a thrown error — `run` reports what git did — so
  // the explanation is attached where the failure is, not only in `fail`.
  const diagnosis = result.exitCode === 0 ? null : diagnoseFailure(result.stderr);
  emit(
    io,
    opts.json === true,
    surface.name,
    {
      op: command.op,
      ...(surface.id === undefined ? {} : { id: surface.id }),
      risk: riskOf(command),
      argv: result.argv,
      dryRun: opts.dryRun === true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      diagnosis:
        diagnosis === null
          ? null
          : { failure: diagnosis.kind, what: diagnosis.what, whatToDo: diagnosis.whatToDo },
      // The last progress line, which is how far the command got. The whole list is of interest while it
      // runs and not after, and a window that only sees the result wants the same one line an agent does.
      progress: reported.at(-1) ?? null,
    },
    (data) =>
      data.dryRun
        ? `would run: git ${data.argv.join(' ')}`
        : `git ${data.argv.join(' ')}${data.stdout}`.trimEnd() +
          (data.diagnosis === null ? '' : `\n${data.diagnosis.what} ${data.diagnosis.whatToDo}`),
  );
}

/**
 * The values a preset's placeholders are filled from, as `--set name=value`.
 *
 * A placeholder this file names and the caller does not is refused rather than filled with nothing: git
 * would take the empty string as a revision and answer with a message about a repository nobody named,
 * which is a worse way to learn that an argument is missing.
 */
function valuesOf(pairs: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) {
      throw new InvalidArgumentError(`--set takes name=value, got ${JSON.stringify(pair)}`);
    }
    values[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return values;
}

/**
 * The command with its placeholders filled, or an argument error naming the ones nobody filled.
 *
 * The same four names the window fills — `{selected}`, `{branch}`, `{path}` and `{message}` — because a
 * command written once has to mean the same thing in both front-ends. The window knows what is selected; a
 * CLI knows nothing the caller did not say, so they come from `--set`.
 */
function fillCommand(
  command: GitCommand,
  values: Readonly<Record<string, string>>,
  id: string,
): GitCommand {
  const filled = JSON.stringify(command).replace(
    /\{(selected|branch|path|message)\}/g,
    (match, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw new InvalidArgumentError(
          `the command "${id}" needs ${match}: pass --set ${name}=<value>`,
        );
      }
      return JSON.stringify(value).slice(1, -1);
    },
  );
  return JSON.parse(filled) as GitCommand;
}

/**
 * The commands file, read the way the window reads it and validated the way anything else here is: by
 * asking the core to build the argv.
 *
 * There is no second schema on this side on purpose. The window validates with the same shape its IPC uses;
 * a CLI has the guarded builder, which refuses an operation it does not know (no argv at all) and an
 * argument that is not a string — so a file with a typo in it produces a refused command with a name and a
 * reason rather than a spawn.
 */
async function readPreset(file: string): Promise<{
  readonly commands: readonly { id: string; command: GitCommand }[];
  readonly broken: readonly string[];
}> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new InvalidArgumentError(
      `no commands file at ${file}: write one with { "commands": [ … ] }, or pass --commands`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InvalidArgumentError(`${file} is not JSON: ${(error as Error).message}`);
  }
  const list =
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { commands?: unknown }).commands)
      ? (parsed as { commands: unknown[] }).commands
      : [];
  const commands: { id: string; command: GitCommand }[] = [];
  const broken: string[] = [];
  for (const entry of list) {
    const id = readId(entry);
    if (id === null) {
      broken.push('an entry with no id');
      continue;
    }
    const command = (entry as { command?: unknown }).command;
    if (!isRunnableCommand(command)) {
      broken.push(id);
      continue;
    }
    commands.push({ id, command });
  }
  return { commands, broken };
}

function readId(entry: unknown): string | null {
  if (entry === null || typeof entry !== 'object') return null;
  const id = (entry as { id?: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Whether this is a command the core will build an argv for: a known operation, and arguments that are
 * strings. `toArgv` is the only place that knows the operations, so it is the one that is asked — a file's
 * `{ "op": "teleport" }` gets no argv and is refused with its id rather than reaching a spawn.
 */
function isRunnableCommand(command: unknown): command is GitCommand {
  if (command === null || typeof command !== 'object') return false;
  try {
    const argv = toArgv(command as GitCommand);
    return Array.isArray(argv) && argv.every((part) => typeof part === 'string' && part !== '');
  } catch {
    return false;
  }
}

/**
 * What each side has, under a heading that names it: two lists rather than one list with marks,
 * because the question a reader has is "what does this branch have that that one does not", and the
 * answer is read one side at a time.
 */
function describeComparison(comparison: Comparison): string {
  const list = (title: string, commits: readonly Commit[]): string =>
    [
      `${title} (${commits.length})`,
      ...commits.map(
        (commit) =>
          `  ${commit.hash.slice(0, 8)} ${new Date(commit.authoredAt * 1000)
            .toISOString()
            .slice(0, 10)} ${commit.author.name.padEnd(20)} ${commit.subject}`,
      ),
    ].join('\n');
  return [
    list(`only on ${comparison.left}`, comparison.onlyLeft),
    list(`only on ${comparison.right}`, comparison.onlyRight),
  ].join('\n');
}

/**
 * Blame, one line of the file per line of output: the commit, who wrote it, when, and what the line
 * says. The date is UTC rather than local, because it is a fact about the commit and the same output
 * from two machines is worth more than a date that moves with the reader.
 */
function describeBlame(lines: readonly BlameLine[]): string {
  return lines
    .map((line) => {
      const date = new Date(line.authorTime * 1000).toISOString().slice(0, 10);
      // The author is padded and never truncated: "Not Committed Ye" reads like a typo, and a long
      // name pushing the column is the reader's problem to solve with their next `--json` call.
      return `${line.oid.slice(0, 8)} ${date} ${line.author.padEnd(20)} ${String(
        line.line,
      ).padStart(4)}  ${line.content}`;
    })
    .join('\n');
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
export type { GitNotFoundError, GraphData, RepoHandle };

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
