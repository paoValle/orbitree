import { join } from 'node:path';

/**
 * Where the quick commands live, on any machine.
 *
 * One file, in the place a person's configuration goes, because the point of it is that it can be
 * committed to their dotfiles: `$XDG_CONFIG_HOME/orbitree/commands.json`, or `~/.config/orbitree/` when
 * that variable is unset, which is the convention every tool that has a file like this follows.
 *
 * Both front-ends read it, so the rule is here rather than written twice: the window and the CLI have to
 * agree about which file "my commands" means, and a rule that lives in two places eventually disagrees
 * with itself. Nothing is written by either of them — the file is the user's to edit.
 */
export function presetPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME;
  const config = base !== undefined && base !== '' ? base : join(homeOf(env), '.config');
  return join(config, 'orbitree', 'commands.json');
}

function homeOf(env: NodeJS.ProcessEnv): string {
  // `HOME` on the two Unix platforms and `USERPROFILE` on Windows, which is what a process that is not
  // Electron has to go on: the app could ask the platform, the CLI cannot.
  return env.HOME ?? env.USERPROFILE ?? '';
}
