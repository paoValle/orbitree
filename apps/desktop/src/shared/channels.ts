/**
 * The channel names, in a module with no runtime dependency.
 *
 * The preload runs sandboxed and may only require a small set of built-ins, so it must not
 * pull the zod schemas in `api.ts` into its bundle just to name a channel. Keeping the names
 * here is what lets the preload stay a whitelist of strings rather than a copy of the schema.
 */
export const CHANNELS = {
  open: 'repo:open',
  status: 'repo:status',
  graph: 'repo:graph',
  refs: 'repo:refs',
  stash: 'repo:stash',
  stashPatch: 'stash:patch',
  worktrees: 'repo:worktrees',
  identity: 'repo:identity',
  remotes: 'repo:remotes',
  conflictSide: 'conflict:side',
  conflictRegions: 'conflict:regions',
  diff: 'repo:diff',
  blame: 'repo:blame',
  run: 'repo:run',
  /** Main to renderer, while a remote command runs: one line of git's progress. */
  runProgress: 'run:progress',
  commitRead: 'commit:read',
  pickDirectory: 'app:pick-directory',
  stateRead: 'app:state-read',
  stateRemember: 'app:state-remember',
  stateSetHotkey: 'app:state-set-hotkey',
  stateForgetLast: 'app:state-forget-last',
  togglePopup: 'app:toggle-popup',
  showWindow: 'app:show-window',
  popupShown: 'popup:shown',
} as const;
