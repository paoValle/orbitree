import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';

/**
 * What the app remembers between runs, and nothing more than it has to.
 *
 * A JSON file under the application's own data directory, read and written on demand: there
 * is no database because there is no query, and no settings framework because there are two
 * fields. It is the reason `orb` does not need a second process.
 */
export interface Persisted {
  /** Directories opened, most recent first. */
  readonly recents: readonly string[];
  /** The repository to reopen on launch, or null to start empty. */
  readonly last: string | null;
  /** The global hotkey for the popup window, or null to use the default. */
  readonly hotkey: string | null;
}

const DEFAULT: Persisted = { recents: [], last: null, hotkey: null };

const FILE = 'state.json';

function path(): string {
  return join(app.getPath('userData'), FILE);
}

/**
 * A file that is not there yet is the same as a file with nothing in it, and so is one that
 * was written by an older version: a missing field is its default rather than an error. A
 * corrupt file is read as the default too, because losing the last directory costs a click
 * and losing the app costs the run.
 */
export async function readState(): Promise<Persisted> {
  let text: string;
  try {
    text = await readFile(path(), 'utf8');
  } catch {
    return DEFAULT;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return DEFAULT;
    const raw = parsed as Partial<Record<keyof Persisted, unknown>>;
    return {
      recents: Array.isArray(raw.recents)
        ? raw.recents.filter((entry): entry is string => typeof entry === 'string')
        : [],
      last: typeof raw.last === 'string' ? raw.last : null,
      hotkey: typeof raw.hotkey === 'string' ? raw.hotkey : null,
    };
  } catch {
    return DEFAULT;
  }
}

/**
 * Write, then rename. `rename` is atomic within a filesystem, so a reader sees the old file or the
 * new one and never a half-written one. Without it, two writers could interleave, the file could
 * be read back as corrupt, and the corrupt read is — by design — the default.
 */
async function writeAtomic(state: Persisted): Promise<void> {
  const file = path();
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

/** One writer at a time. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * The only way to change this file.
 *
 * The window and the popup are two renderers over one main process, and both of them can react to
 * the same event: opening the last repository, finding it gone, clearing it. Two read-modify-write
 * cycles at once lose one of the two changes — a real report of it was `recents` coming back empty
 * after a repository was reopened and found missing. Serialising is the fix; the alternative is
 * every caller remembering to be careful.
 */
export function mutateState(change: (state: Persisted) => Persisted): Promise<Persisted> {
  const next = queue.then(async () => {
    const state = await readState();
    const updated = change(state);
    await writeAtomic(updated);
    return updated;
  });
  // The queue must survive a failed write, or one bad save would stop every later one.
  queue = next.catch(() => undefined);
  return next;
}

export async function writeState(state: Persisted): Promise<void> {
  await mutateState(() => state);
}
