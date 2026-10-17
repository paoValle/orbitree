import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type GitCommand, InvalidArgumentError, isDestructive, riskOf, toArgv } from './command.ts';
import {
  countConflictStarts,
  linesOf,
  parseConflictRegions,
  resolutionPatch,
  wholeFilePatch,
} from './conflict.ts';
import { credentialRequestText } from './credential.ts';
import { parseDiff, patchForHunk } from './diff.ts';
import { parseProgressLine, type Progress } from './progress.ts';
import { redact } from './redact.ts';

export class GitNotFoundError extends Error {
  override readonly name = 'GitNotFoundError';
  constructor() {
    super(
      'git was not found on PATH. Install Git 2.43 or newer (https://git-scm.com/downloads) and try again.',
    );
  }
}

/**
 * Errors carry their context as ordinary fields, not as constructor parameter
 * properties: parameter properties are the one piece of TypeScript that cannot be
 * stripped, and the CLI is meant to run straight from source with `node --experimental-strip-types`.
 */
export class GitTimeoutError extends Error {
  override readonly name = 'GitTimeoutError';
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  constructor(argv: readonly string[], timeoutMs: number) {
    super(`git timed out after ${timeoutMs} ms: ${argv.join(' ')}`);
    this.argv = argv;
    this.timeoutMs = timeoutMs;
  }
}

export class GitFailedError extends Error {
  override readonly name = 'GitFailedError';
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stderr: string;
  constructor(argv: readonly string[], exitCode: number, stderr: string) {
    // The fallback names the command when git said nothing, and a command can hold a credential:
    // `redact` covers both halves.
    super(`git exited with ${exitCode}: ${redact(stderr.trim() || argv.join(' '))}`);
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class ConfirmationRequiredError extends Error {
  override readonly name = 'ConfirmationRequiredError';
  readonly op: GitCommand['op'];
  constructor(op: GitCommand['op']) {
    super(
      `refusing to run the destructive operation "${op}" without a confirmation token. ` +
        'Pass one explicitly, or use --dry-run to see the command first.',
    );
    this.op = op;
  }
}

/**
 * The working directory does not exist.
 *
 * Spawning with a bad working directory fails with the same errno as a missing binary, so the
 * ambiguity is resolved here and given a name of its own. A GUI needs it: a remembered repository
 * whose directory has gone is a state to show, not an error to print.
 */
export class PathNotFoundError extends Error {
  override readonly name = 'PathNotFoundError';
  readonly path: string;
  constructor(path: string) {
    super(`not a directory: ${path}`);
    this.path = path;
  }
}

export class OutputTooLargeError extends Error {
  override readonly name = 'OutputTooLargeError';
  readonly bytes: number;
  constructor(bytes: number) {
    super(`git produced ${bytes} bytes of output; the cap is ${MAX_OUTPUT_BYTES}`);
    this.bytes = bytes;
  }
}

export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * A confirmation is not a boolean: it records who asked, why and when, so that a
 * destructive operation in a log has an author. A `true` would be indistinguishable
 * from a UI bug that always sends `true`.
 */
export interface Confirmation {
  readonly confirmedBy: string;
  readonly reason: string;
  /** ISO-8601. */
  readonly at: string;
}

export interface ExecuteOptions {
  readonly cwd: string;
  /** Required for a destructive command; `undefined` is refused. */
  readonly confirmation?: Confirmation;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Called as git reports progress, one call per line, for the commands that report it at all
   * (`fetch`, `pull` and `push`, whose argv carries `--progress`).
   *
   * A callback rather than a promise over a list, because a fetch that takes a minute is exactly
   * the case this exists for: a caller that wants the lines afterwards can collect them itself, and
   * one that wants to show them as they arrive does not have to wait for the command to finish.
   */
  readonly onProgress?: (progress: Progress) => void;
  /** Builds the argv and returns it without running anything. */
  readonly dryRun?: boolean;
}

export interface GitResult {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** `dangerous` is remembered for the audit line, not for the caller to re-decide. */
  readonly risk: ReturnType<typeof riskOf>;
}

const REMOTE_TIMEOUT_MS = 120_000;
const LOCAL_TIMEOUT_MS = 30_000;

/**
 * The environment git is given. Each variable here exists because of a specific failure:
 * a GUI that hangs on a password prompt it cannot show, an index lock taken under the
 * user's own terminal, a pager waiting for a keypress that never comes.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  // Never block on a credential prompt: fail with a message the UI can act on.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  // A background status refresh must not take the index lock away from the user.
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  return env;
}

/**
 * The argv as it may be *shown*: the same words with any credential in them masked.
 *
 * A remote URL can hold a token, `git push --progress https://user:ghp_…@host/x.git` is a real argv,
 * and both front-ends show this line and let it be copied. `toArgv` stays pure and unredacted — it is
 * what git is given — and this is applied where the argv leaves the process, exactly as `stdout` and
 * `stderr` are.
 */
function shownArgv(argv: readonly string[]): readonly string[] {
  return argv.map(redact);
}

/** A fresh request: the executor is the only thing that knows how to be careful. */
export async function execute(cmd: GitCommand, options: ExecuteOptions): Promise<GitResult> {
  const risk = riskOf(cmd);
  const argv = toArgv(cmd);

  // A dry run is how a caller finds out *what* it is being asked to confirm, so it is the
  // one path that gets to resolve the argv first. Nothing is spawned here.
  if (options.dryRun === true) {
    return { argv: shownArgv(argv), exitCode: 0, stdout: '', stderr: '', durationMs: 0, risk };
  }

  // Fail closed. `riskOf` is exhaustive over the command union, so an operation with a new
  // risk cannot slip past this check by being forgotten in a second table.
  if (isDestructive(cmd) && options.confirmation === undefined) {
    throw new ConfirmationRequiredError(cmd.op);
  }
  if (options.confirmation !== undefined && options.confirmation.reason.trim() === '') {
    throw new InvalidArgumentError('a destructive operation needs a reason, not just a click');
  }
  const started = Date.now();
  // Spawning with a bad working directory fails with the same errno as a missing binary,
  // and "git is not installed" would be a lie. Checked here, once, where the ambiguity is.
  if (!isDirectory(options.cwd)) {
    throw new PathNotFoundError(options.cwd);
  }

  const timeoutMs = options.timeoutMs ?? (risk === 'remote' ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS);
  const input = await stdinFor(cmd, options);
  const { stdout, stderr, exitCode } = await spawnGit(argv, {
    cwd: options.cwd,
    env: gitEnv(options.env),
    timeoutMs,
    ...(input === null ? {} : { input }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  return {
    argv: shownArgv(argv),
    exitCode,
    // Redacted on the way in: nothing downstream has to remember.
    stdout: redact(stdout),
    stderr: redact(stderr),
    durationMs: Date.now() - started,
    risk,
  };
}

/** Like `execute`, but a non-zero exit is an error. Used by the typed operations. */
export async function executeOrThrow(cmd: GitCommand, options: ExecuteOptions): Promise<GitResult> {
  const result = await execute(cmd, options);
  if (result.exitCode !== 0) {
    throw new GitFailedError(result.argv, result.exitCode, result.stderr);
  }
  return result;
}

/**
 * The patch that replaces a whole file with what a caller decided it should say.
 *
 * The same read-then-build as the region resolver, for the same reason: the removals are the file's
 * own lines and the additions are the caller's text, each prefixed, so a line of that text that reads
 * like a patch header is one added line.
 */
function wholeFilePatchFor(cmd: Extract<GitCommand, { op: 'resolve-file' }>, cwd: string): string {
  const file = join(cwd, cmd.path);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new InvalidArgumentError(`${cmd.path} is not a file`);
  }
  const text = readFileSync(file, 'utf8');
  if (!text.endsWith('\n')) {
    throw new InvalidArgumentError(
      `${cmd.path} does not end with a newline, which a patch cannot express`,
    );
  }
  const replacement = cmd.content === '' ? [] : cmd.content.replace(/\n$/, '').split('\n');
  return wholeFilePatch(cmd.path, linesOf(text), replacement);
}

/**
 * The patch that resolves one conflict region, built from the file as it is on disk.
 *
 * The read is what makes the rest safe: the region's own lines are what the patch removes, so a
 * caller's `custom` text can only ever become the *added* lines of that one region — it cannot name
 * another file, and it cannot become a header, because every added line is prefixed.
 */
function resolutionPatchFor(
  cmd: Extract<GitCommand, { op: 'resolve-conflict' }>,
  cwd: string,
): string {
  const file = join(cwd, cmd.path);
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new InvalidArgumentError(`${cmd.path} is not a file`);
  }
  const text = readFileSync(file, 'utf8');
  if (!text.endsWith('\n')) {
    throw new InvalidArgumentError(
      `${cmd.path} does not end with a newline, which a patch cannot express`,
    );
  }
  const lines = linesOf(text);
  const regions = parseConflictRegions(lines);
  // A file with a marker the parser could not pair up is a file whose regions are not the ones a
  // caller counted, and resolving region 2 of a half-read list would be resolving a different one.
  if (regions.length !== countConflictStarts(lines)) {
    throw new InvalidArgumentError(`${cmd.path} has conflict markers that do not pair up`);
  }
  const region = regions[cmd.region];
  if (region === undefined) {
    throw new InvalidArgumentError(
      `${cmd.path} has ${regions.length} conflict region${regions.length === 1 ? '' : 's'}, so region ${cmd.region} cannot be resolved`,
    );
  }
  const replacement =
    cmd.take === 'ours'
      ? region.ours
      : cmd.take === 'theirs'
        ? region.theirs
        : cmd.take === 'both'
          ? [...region.ours, ...region.theirs]
          : linesOf(cmd.content ?? '');
  return resolutionPatch(cmd.path, lines, region, replacement);
}

interface SpawnOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  /** What the child reads on stdin, when it reads anything at all. */
  readonly input?: string;
  readonly signal?: AbortSignal;
  /** Called per progress line, for the commands whose argv asks git for them. */
  readonly onProgress?: (progress: Progress) => void;
}

/**
 * What a command feeds git on stdin, or `null` when it feeds nothing.
 *
 * One command needs it. Reversing a single hunk is `git apply --reverse` on a patch for that
 * hunk, and the patch is built here — from a fresh read of the file's own diff, inside the
 * process that runs git — rather than accepted from a caller. A patch that arrived over a channel
 * would be somebody's belief about what the working tree holds, and it is the working tree being
 * changed.
 *
 * The read happens after the confirmation check, so a destructive command still cannot touch the
 * repository before a reason exists.
 */
async function stdinFor(cmd: GitCommand, options: ExecuteOptions): Promise<string | null> {
  // The credential request is what git reads, and it is data rather than an argument: it belongs on
  // stdin, where the protocol says it goes.
  if (cmd.op === 'credential-fill') return credentialRequestText(cmd.request);
  if (cmd.op === 'resolve-conflict') return resolutionPatchFor(cmd, options.cwd);
  if (cmd.op === 'resolve-file') return wholeFilePatchFor(cmd, options.cwd);
  if (cmd.op !== 'discard-hunk') return null;

  const read = await executeOrThrow({ op: 'diff', path: cmd.path }, options);
  const parsed = parseDiff(read.stdout);
  if (!parsed.ok) {
    throw new InvalidArgumentError(`the diff of ${cmd.path} could not be read: ${parsed.error}`);
  }
  const file = parsed.value.find((candidate) => candidate.path === cmd.path);
  if (file === undefined) {
    throw new InvalidArgumentError(`git reports no uncommitted change for ${cmd.path}`);
  }
  const patch = patchForHunk(file, cmd.hunk);
  if (patch === null) {
    throw new InvalidArgumentError(
      `${cmd.path} has ${file.hunks.length} hunk${file.hunks.length === 1 ? '' : 's'}, so hunk ${cmd.hunk} cannot be reversed`,
    );
  }
  return patch;
}

function spawnGit(
  argv: readonly string[],
  options: SpawnOptions,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // An argv array and `shell: false`. The only thing that keeps a filename with a
    // space, a `$(rm -rf ~)` or a quote in it from becoming a shell feature is here.
    const child: ChildProcess = spawn('git', [...argv], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      // A pipe only when there is something to write: an ignored stdin is a child that cannot
      // block on a read nobody will answer.
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });

    if (options.input !== undefined) {
      // Ended rather than left open: `git apply -` reads until the stream closes.
      child.stdin?.end(options.input);
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new GitTimeoutError(shownArgv(argv), options.timeoutMs));
    }, options.timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new InvalidArgumentError('the git call was cancelled'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        settled = true;
        child.kill('SIGKILL');
        cleanup();
        reject(new OutputTooLargeError(bytes));
        return;
      }
      chunks.push(chunk);
    };

    child.stdout?.on('data', (chunk: Buffer) => collect(out, chunk));
    // Progress is on stderr, separated by carriage returns, so a line is only a line once one of
    // those or a newline has arrived: what is left in `pending` is a row still being overwritten.
    let pending = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      collect(err, chunk);
      if (options.onProgress === undefined) return;
      pending += chunk.toString('utf8');
      const parts = pending.split(/\r|\n/);
      pending = parts.pop() ?? '';
      for (const part of parts) {
        const progress = parseProgressLine(part);
        if (progress !== null) options.onProgress(progress);
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ENOENT') reject(new GitNotFoundError());
      else reject(error);
    });

    child.on('close', (code) => {
      cleanup();
      if (settled) return;
      settled = true;
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code ?? -1,
      });
    });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The version of the `git` binary that will actually be used, as a comparable tuple. */
export async function gitVersion(cwd: string): Promise<string> {
  const { stdout } = await executeOrThrow({ op: 'version' }, { cwd });
  return stdout.trim().replace(/^git version\s+/, '');
}

/**
 * The floor the product is written against: `git restore`, `git switch`, porcelain v2 with
 * `--branch`, and `--force-with-lease` are all older than this, but 2.43 is where
 * `for-each-ref --format` and `status -z` behave the same on every platform we ship on.
 */
export const MINIMUM_GIT_VERSION = '2.43';

export function meetsMinimumGitVersion(version: string, minimum = MINIMUM_GIT_VERSION): boolean {
  const parse = (value: string): number[] =>
    (
      value
        .split(/[.\s]/)
        .slice(0, 3)
        .map((part) => Number.parseInt(part, 10)) as number[]
    ).map((part) => (Number.isFinite(part) ? part : 0));
  const [have, need] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
