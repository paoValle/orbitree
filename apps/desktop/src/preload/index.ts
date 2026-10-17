import { contextBridge, ipcRenderer } from 'electron';
import type { OrbitreeApi, RunRequest } from '../shared/api.ts';
import { CHANNELS } from '../shared/channels.ts';

/**
 * The whole surface the renderer gets. No generic `invoke`, so a compromised renderer
 * cannot reach a channel this file does not name.
 */
const api: OrbitreeApi = {
  open: (path) => ipcRenderer.invoke(CHANNELS.open, path),
  status: (path) => ipcRenderer.invoke(CHANNELS.status, path),
  graph: (path, request) => ipcRenderer.invoke(CHANNELS.graph, { path, ...request }),
  refs: (path) => ipcRenderer.invoke(CHANNELS.refs, path),
  readStash: (path) => ipcRenderer.invoke(CHANNELS.stash, path),
  readWorktrees: (path) => ipcRenderer.invoke(CHANNELS.worktrees, path),
  readIdentity: (path) => ipcRenderer.invoke(CHANNELS.identity, path),
  readStashPatch: (request) => ipcRenderer.invoke(CHANNELS.stashPatch, request),
  readConflictSide: (request) => ipcRenderer.invoke(CHANNELS.conflictSide, request),
  readConflictRegions: (request) => ipcRenderer.invoke(CHANNELS.conflictRegions, request),
  diff: (path, request) => ipcRenderer.invoke(CHANNELS.diff, { path, ...request }),
  readCommit: (path, rev) => ipcRenderer.invoke(CHANNELS.commitRead, { path, rev }),
  run: (request: RunRequest) => ipcRenderer.invoke(CHANNELS.run, request),
  pickDirectory: () => ipcRenderer.invoke(CHANNELS.pickDirectory),
  togglePopup: () => ipcRenderer.invoke(CHANNELS.togglePopup),
  // The main process says when the quick window appears, because the repository it is about
  // is whatever the main window last opened, and that can change while it is hidden.
  onShown: (callback) => ipcRenderer.on(CHANNELS.popupShown, () => callback()),
  onRunProgress: (callback) =>
    ipcRenderer.on(CHANNELS.runProgress, (_event, progress) => callback(progress)),
  showWindow: () => ipcRenderer.invoke(CHANNELS.showWindow),
  readState: () => ipcRenderer.invoke(CHANNELS.stateRead),
  remember: (path) => ipcRenderer.invoke(CHANNELS.stateRemember, { path }),
  setHotkey: (hotkey) => ipcRenderer.invoke(CHANNELS.stateSetHotkey, { hotkey }),
  forgetLast: (path) => ipcRenderer.invoke(CHANNELS.stateForgetLast, { path }),
};

contextBridge.exposeInMainWorld('orbitree', api);
