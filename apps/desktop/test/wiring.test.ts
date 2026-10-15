import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The desktop shell's security is configuration, and configuration regresses silently: nobody
 * notices `sandbox: false` until it is an advisory. These are assertions about the files, which
 * is the only cheap way to keep them true.
 */
const ROOT = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8');

const main = read('src/main/index.ts');
const preload = read('src/preload/index.ts');
const html = read('src/renderer/index.html');
const config = read('electron.vite.config.ts');
const styles = read('src/renderer/styles.css');
const icons = read('src/renderer/icons.tsx');

/** Every glyph `docs/DESIGN.md` names, so a rename cannot silently drop one. */
const REQUIRED_ICONS = [
  'fetch',
  'pull',
  'push',
  'stash',
  'unstash',
  'clean',
  'reset',
  'file-text',
  'file-code',
  'file-json',
  'file-image',
  'file-binary',
  'file-config',
  'file-shell',
  'file-markdown',
  'branch',
  'remote',
  'tag',
  'head',
  'commit',
  'tree',
  'activity',
  'close',
  'chevron-down',
  'folder',
  'search',
] as const;

describe('the window the app opens', () => {
  it('is an ordinary web page, not a shell', () => {
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('sandbox: true');
    expect(main).toContain('webviewTag: false');
    expect(main).not.toContain('nodeIntegration: true');
    expect(main).not.toContain('contextIsolation: false');
    expect(main).not.toContain('allowRunningInsecureContent');
  });

  it('opens a link in the real browser and never inside the app', () => {
    expect(main).toContain('setWindowOpenHandler');
    expect(main).toMatch(/setWindowOpenHandler[\s\S]{0,200}action: 'deny'/);
    expect(main).toContain('shell.openExternal');
  });

  it('has a content security policy with no eval and no remote code', () => {
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('unsafe-eval');
    expect(html).toMatch(/script-src 'self'/);
    expect(html).toMatch(/default-src 'self'/);
    expect(html).not.toMatch(/https:\/\//);
  });
});

describe('the boundary between the renderer and the process that can run git', () => {
  it('exposes a fixed list of functions, never a generic invoke', () => {
    expect(preload).toContain('contextBridge.exposeInMainWorld');
    // The whole point: no `invoke: (channel, ...) => ipcRenderer.invoke(channel, ...)`.
    expect(preload).not.toMatch(/invoke:\s*\([^)]*channel/);
    expect(preload).not.toMatch(/send:\s*\(/);
    // Every channel is named, and it comes from the shared constants.
    expect(preload).toContain('CHANNELS.open');
    expect(preload).toContain('CHANNELS.run');
  });

  it('parses what arrives instead of trusting it', () => {
    expect(main).toContain('runRequestSchema.parse');
    expect(main).not.toMatch(/\bpickDirectory\b[\s\S]{0,200}as \{/);
  });

  it('the preload path in the main process is the file the build emits', () => {
    const referenced = /preload: join\(import\.meta\.dirname, '(\.\.\/[^']+)'\)/.exec(main)?.[1];
    const emitted = /entryFileNames: '([^']+)'/.exec(config)?.[1];
    expect(referenced).toBe('../preload/index.cjs');
    expect(emitted).toBe('index.cjs');
    // Same file name on both sides: a mismatch here means the app opens with no API at all,
    // which looks like a broken build rather than a wrong path.
    expect(referenced?.split('/').pop()).toBe(emitted);
    // And a sandboxed preload cannot be an ES module.
    expect(emitted).not.toMatch(/\.mjs$/);
  });
});

/**
 * The icon set is source, not a dependency, so its contract is checked in the same place the
 * window's configuration is: every glyph the design names exists and carries its own name.
 */
describe('the icon set', () => {
  it('declares every glyph under its kebab-case data-icon name', () => {
    for (const name of REQUIRED_ICONS) {
      expect(icons).toContain(`name="${name}"`);
    }
  });

  it('draws each glyph on the 24px grid with a single 1.5px current-colour stroke', () => {
    expect(icons).toContain('viewBox="0 0 24 24"');
    expect(icons).toContain('strokeWidth={1.5}');
    expect(icons).toContain('stroke="currentColor"');
    expect(icons).toContain('fill="none"');
  });
});

/**
 * The motion rules that are easy to break silently: a keyframe creeps in, a duration is
 * changed, the reduced-motion block is edited, the canvas is animated. A rule with no check
 * is a comment, so each one is asserted by name against the stylesheet text.
 */
describe('the window a spec is allowed to talk to', () => {
  it('never asks for the first window, because that is the popup half the time', () => {
    const specs = readdirSync(join(ROOT, 'test', 'e2e'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.spec\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name));

    expect(specs.length).toBeGreaterThan(8);
    const offenders = specs
      .filter((path) => readFileSync(path, 'utf8').includes('firstWindow()'))
      .map((path) => path.replace(`${ROOT}/`, ''));

    // The app creates its quick window at startup, so `firstWindow()` returns whichever of the
    // two Electron enumerated first. Nine specs did this, and the suite failed in a different
    // one each time depending on which window won the race: a screenshot of the failure showed
    // the popup, with "no repository" where the graph should have been.
    expect(offenders).toEqual([]);
  });
});

describe('the motion rules', () => {
  it('removes every transition and animation under reduced motion, with no exception', () => {
    const start = styles.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(start).toBeGreaterThan(-1);
    const block = styles.slice(start);
    expect(block).toContain('animation: none');
    expect(block).toContain('transition: none');
    expect(block).toContain('*::before');
    expect(block).toContain('*::after');
  });

  it('declares no keyframe anywhere', () => {
    expect(styles).not.toContain('@keyframes');
  });

  it('never transitions the graph canvas, the lanes or a row transform', () => {
    const canvasRule = /\.commit-graph\s*\{([^}]*)\}/.exec(styles)?.[1] ?? '';
    expect(canvasRule).not.toContain('transition');
    // A row declares no `transform`: the graph appears with its content or not at all.
    const rowRule = /\.row\s*\{([^}]*)\}/.exec(styles)?.[1] ?? '';
    expect(rowRule).not.toContain('transform');
  });

  it('never runs a transition longer than the 240ms whole-pane ceiling', () => {
    const declarations = styles.match(/transition\s*:[^;]*;/g) ?? [];
    expect(declarations.length).toBeGreaterThan(0);
    const durations = declarations.flatMap((declaration) =>
      [...declaration.matchAll(/(\d+)ms/g)].map((match) => Number(match[1])),
    );
    expect(durations.length).toBeGreaterThan(0);
    for (const duration of durations) expect(duration).toBeLessThanOrEqual(240);
  });
});
