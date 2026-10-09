import { type GitCommand, InvalidArgumentError } from './git/command.ts';
import { type ExecuteOptions, execute, executeOrThrow, type GitResult } from './git/exec.ts';
import { type Commit, parseLog, parseRefs, type Ref } from './git/log.ts';
import { parseStatus, type RepoState } from './git/status.ts';
import { type GraphLayout, layoutGraph, refsByOid } from './graph/layout.ts';

export class NotARepositoryError extends Error {
  override readonly name = 'NotARepositoryError';
  readonly path: string;
  constructor(path: string) {
    super(`${path} is not inside a git working tree`);
    this.path = path;
  }
}

export class RepositoryParseError extends Error {
  override readonly name = 'RepositoryParseError';
  readonly what: string;
  readonly detail: string;
  readonly record: string;
  constructor(what: string, detail: string, record: string) {
    super(`could not read ${what}: ${detail}`);
    this.what = what;
    this.detail = detail;
    this.record = record;
  }
}

export interface RepoHandle {
  /** Absolute path to the working tree root, as git reports it. */
  readonly root: string;
}

export interface GraphData {
  readonly commits: readonly Commit[];
  readonly layout: GraphLayout;
  readonly refs: readonly Ref[];
  readonly refsByOid: ReturnType<typeof refsByOid>;
}

/**
 * The API both front-ends call. The desktop app and the CLI are two ways of asking these
 * same questions — neither of them contains its own copy of a git invocation, which is
 * the only way the two can be guaranteed to agree.
 */
export async function openRepo(
  path: string,
  options: Partial<ExecuteOptions> = {},
): Promise<RepoHandle> {
  const result = await execute({ op: 'repo-root' }, { cwd: path, ...options });
  if (result.exitCode !== 0) throw new NotARepositoryError(path);
  const root = result.stdout.trim();
  if (root === '') throw new NotARepositoryError(path);
  return { root };
}

export async function readStatus(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<RepoState> {
  const { stdout } = await executeOrThrow({ op: 'status' }, { cwd: repo.root, ...options });
  const parsed = parseStatus(stdout);
  if (!parsed.ok)
    throw new RepositoryParseError('the repository status', parsed.error, parsed.record);
  return parsed.value;
}

export async function readRefs(
  repo: RepoHandle,
  options: Partial<ExecuteOptions> = {},
): Promise<readonly Ref[]> {
  const { stdout } = await executeOrThrow({ op: 'refs' }, { cwd: repo.root, ...options });
  const parsed = parseRefs(stdout);
  if (!parsed.ok) throw new RepositoryParseError('the refs', parsed.error, parsed.record);
  return parsed.value;
}

export interface GraphRequest {
  readonly limit?: number;
  readonly all?: boolean;
}

export async function readGraph(
  repo: RepoHandle,
  request: GraphRequest = {},
  options: Partial<ExecuteOptions> = {},
): Promise<GraphData> {
  const limit = request.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidArgumentError(`limit must be a positive integer, got ${limit}`);
  }
  const [log, refs] = await Promise.all([
    executeOrThrow(
      { op: 'graph', limit, ...(request.all === true ? { all: true } : {}) },
      { cwd: repo.root, ...options },
    ),
    readRefs(repo, options),
  ]);
  const parsed = parseLog(log.stdout);
  if (!parsed.ok) throw new RepositoryParseError('the commit log', parsed.error, parsed.record);
  return {
    commits: parsed.value,
    layout: layoutGraph(parsed.value),
    refs,
    refsByOid: refsByOid(refs),
  };
}

/**
 * The escape hatch for operations the typed union does not have yet. It still goes
 * through the executor, so confirmation, timeouts, redaction and `shell: false` apply.
 */
export async function run(cmd: GitCommand, options: ExecuteOptions): Promise<GitResult> {
  return execute(cmd, options);
}
