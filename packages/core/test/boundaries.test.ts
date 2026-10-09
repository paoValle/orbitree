import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function sourceFiles(relative: string): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const entry of readdirSync(join(ROOT, relative), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    const path = join(entry.parentPath, entry.name);
    files.push({ path, text: readFileSync(path, 'utf8') });
  }
  return files;
}

/**
 * A layering claim that is not checked is a comment. These two tests are what keeps the
 * structure in `docs/ARCHITECTURE.md` true a year from now, when somebody needs "just one
 * small fetch" inside the core.
 */
describe('the shape of the code, checked rather than asserted in prose', () => {
  it('[I7] the core never reaches the network and never reaches the screen', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('packages/core/src')) {
      const rules: [RegExp, string][] = [
        [/from ['"]node:(http|https|net|tls|dgram)['"]/, 'a network module'],
        [/\b(fetch|XMLHttpRequest)\s*\(/, 'a network call'],
        [/from ['"]electron['"]|from ['"]react/, 'a UI dependency'],
        [/from ['"]\.\.\/\.\.\/apps\//, 'an import from the desktop app'],
      ];
      for (const [pattern, what] of rules) {
        if (pattern.test(file.text))
          offenders.push(`${file.path.replace(`${ROOT}/`, '')}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('[I3] the front-ends never spawn anything: git is reached through the core, or not at all', () => {
    const offenders: string[] = [];
    for (const relative of ['apps/desktop/src', 'packages/cli/src']) {
      for (const file of sourceFiles(relative)) {
        const rules: [RegExp, string][] = [
          [/from ['"]node:child_process['"]/, 'a process spawn'],
          [/\b(spawn|execFile|execSync|exec)\s*\(/, 'a process spawn'],
          // A second argv builder is how two front-ends start disagreeing about `--`.
          [/\[['"]status['"],\s*['"]--porcelain/, 'a hand-built git argv'],
        ];
        for (const [pattern, what] of rules) {
          if (pattern.test(file.text))
            offenders.push(`${file.path.replace(`${ROOT}/`, '')}: ${what}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the IPC schema covers every operation the core accepts', () => {
    // The compile-time half of this is in apps/desktop/src/shared/api.ts; this half fails
    // loudly if somebody deletes that assertion instead of extending the schema.
    const api = readFileSync(join(ROOT, 'apps/desktop/src/shared/api.ts'), 'utf8');
    expect(api).toContain('SchemaCoversCore');
    expect(api).toContain("literal('reset-hard')");
    expect(api).toContain("literal('discard')");
  });
});
