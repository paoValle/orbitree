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
  diff: (path, request) => ipcRenderer.invoke(CHANNELS.diff, { path, ...request }),
  readCommit: (path, rev) => ipcRenderer.invoke(CHANNELS.commitRead, { path, rev }),
  run: (request: RunRequest) => ipcRenderer.invoke(CHANNELS.run, request),
  pickDirectory: () => ipcRenderer.invoke(CHANNELS.pickDirectory),
};

contextBridge.exposeInMainWorld('orbitree', api);
