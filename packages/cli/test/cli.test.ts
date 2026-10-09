import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openRepo, readStatus } from '@orbitree/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliIo, EXIT, main } from '../src/index.ts';

const execFileAsync = promisify(execFile);

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orbitree-cli-'));
  const git = (...args: string[]): Promise<unknown> =>
    execFileAsync('git', args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  await git('init', '-b', 'main', '--quiet');
  await git('config', 'user.name', 'CLI Test');
  await git('config', 'user.email', 'cli@example.invalid');
  await writeFile(join(root, 'a.txt'), 'one\n', 'utf8');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'the first commit');
  await writeFile(join(root, 'a.txt'), 'two\n', 'utf8');
  await writeFile(join(root, 'b.txt'), 'new\n', 'utf8');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Capture {
  readonly io: CliIo;
  readonly lines: string[];
  readonly errors: string[];
}

function capture(): Capture {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      out: (line) => lines.push(line),
      err: (line) => errors.push(line),
    },
  };
}

async function cli(
  argv: readonly string[],
): Promise<{ code: number; lines: string[]; errors: string[] }> {
  const captured = capture();
  const code = await main(argv, captured.io);
  return { code, lines: captured.lines, errors: captured.errors };
}

describe('the CLI and the app are the same program', () => {
  it('[I3] `status --json` is the core’s own reading, not a second parser', async () => {
    const result = await cli(['status', root, '--json']);
    expect(result.code).toBe(EXIT.ok);
    expect(result.lines).toHaveLength(1);

    const printed = JSON.parse(result.lines[0] as string) as {
      schemaVersion: number;
      command: string;
      ok: boolean;
      data: { root: string; entries: unknown[]; head: { kind: string } };
    };
    expect(printed.command).toBe('status');
    expect(printed.ok).toBe(true);

    // The same call through the library: byte-identical, because it is the same function.
    const repo = await openRepo(root);
    const state = await readStatus(repo);
    expect(printed.data.root).toBe(repo.root);
    expect(printed.data.head).toEqual(state.head);
    expect(printed.data.entries).toEqual(state.entries);
    expect(printed.data.entries).toHaveLength(2);
  });

  it('[I3] `graph --json` carries lanes and edges', async () => {
    const result = await cli(['graph', root, '--json', '--limit', '10']);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: { rows: { lane: number }[]; edges: unknown[]; laneCount: number };
    };
    expect(printed.data.laneCount).toBe(1);
    expect(printed.data.rows).toHaveLength(1);
    expect(printed.data.edges).toHaveLength(0);
  });

  it('a JSON failure is still one JSON object, with a kind and an exit code', async () => {
    const result = await cli(['status', '/tmp', '--json']);
    expect(result.code).toBe(EXIT.notARepository);
    const printed = JSON.parse(result.lines[0] as string) as {
      ok: boolean;
      error: { kind: string; message: string };
    };
    expect(printed.ok).toBe(false);
    expect(printed.error.kind).toBe('not-a-repository');
    expect(printed.error.message.length).toBeGreaterThan(0);
  });

  it('[I1] a destructive operation is refused with its own exit code', async () => {
    const result = await cli(['run', root, '--op', 'clean', '--json']);
    expect(result.code).toBe(EXIT.confirmationRequired);
    const printed = JSON.parse(result.lines[0] as string) as { error: { kind: string } };
    expect(printed.error.kind).toBe('confirmation-required');
  });

  it('[I1] a dry run prints the argv and leaves the working tree alone', async () => {
    const before = await readStatus(await openRepo(root));
    const result = await cli(['run', root, '--op', 'clean', '--dry-run', '--json']);
    expect(result.code).toBe(EXIT.ok);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: { argv: string[]; risk: string };
    };
    expect(printed.data.argv).toEqual(['clean', '-fd']);
    expect(printed.data.risk).toBe('destructive');
    const after = await readStatus(await openRepo(root));
    expect(after.entries).toEqual(before.entries);
  });

  it('[I1] a confirmed destructive command runs, and the confirmation is a reason', async () => {
    await writeFile(join(root, 'scratch.txt'), 'temporary\n', 'utf8');
    const result = await cli([
      'run',
      root,
      '--op',
      'clean',
      '--confirm',
      'removing a scratch file',
      '--json',
    ]);
    expect(result.code).toBe(EXIT.ok);
    const printed = JSON.parse(result.lines[0] as string) as {
      data: { exitCode: number; op: string };
    };
    expect(printed.data.op).toBe('clean');
    expect(printed.data.exitCode).toBe(0);
    const after = await readStatus(await openRepo(root));
    expect(after.entries.map((entry) => entry.path)).not.toContain('scratch.txt');
  });

  it('an unknown operation is a usage error, not a guess', async () => {
    const result = await cli(['run', root, '--op', 'rm-rf', '--json']);
    expect(result.code).toBe(EXIT.usage);
    const printed = JSON.parse(result.lines[0] as string) as { error: { kind: string } };
    expect(printed.error.kind).toBe('invalid-argument');
  });

  it('`doctor` and `ops` answer without a repository', async () => {
    const doctor = await cli(['doctor', root, '--json']);
    const report = JSON.parse(doctor.lines[0] as string) as {
      data: { gitIsNewEnough: boolean; git: string };
    };
    expect(report.data.gitIsNewEnough).toBe(true);

    const ops = await cli(['ops', '--json']);
    const listing = JSON.parse(ops.lines[0] as string) as { data: { op: string; risk: string }[] };
    expect(listing.data.length).toBeGreaterThan(15);
    expect(listing.data.some((row) => row.risk === 'destructive')).toBe(true);
  });

  it('`schema` is machine-readable, and `--help` is not an error', async () => {
    const schema = await cli(['schema']);
    const parsed = JSON.parse(schema.lines[0] as string) as { exitCodes: { ok: number } };
    expect(parsed.exitCodes.ok).toBe(0);
    expect(await cli(['--help']).then((result) => result.code)).toBe(EXIT.ok);
    expect(await cli(['nonsense']).then((result) => result.code)).toBe(EXIT.usage);
  });
});
