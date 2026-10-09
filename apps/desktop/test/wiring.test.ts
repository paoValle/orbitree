import { readFileSync } from 'node:fs';
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
