import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type KeplerkApi, type RunRequest } from '../shared/api.ts';

/**
 * The whole surface the renderer gets. No generic `invoke`, so a compromised renderer
 * cannot reach a channel this file does not name.
 */
const api: KeplerkApi = {
  open: (path) => ipcRenderer.invoke(CHANNELS.open, path),
  status: (path) => ipcRenderer.invoke(CHANNELS.status, path),
  graph: (path, request) => ipcRenderer.invoke(CHANNELS.graph, { path, ...request }),
  refs: (path) => ipcRenderer.invoke(CHANNELS.refs, path),
  run: (request: RunRequest) => ipcRenderer.invoke(CHANNELS.run, request),
  pickDirectory: () => ipcRenderer.invoke(CHANNELS.pickDirectory),
};

contextBridge.exposeInMainWorld('keplerk', api);
