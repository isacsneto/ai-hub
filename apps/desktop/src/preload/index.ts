import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { API_METHODS } from '../shared/methods';

// Only these named calls cross into the main process; the page gets no Node or Electron access.
const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`aihub:${m}`, ...args)]));

contextBridge.exposeInMainWorld('aihub', {
  ...api,
  /** Update progress pushed from the main process; returns an unsubscribe function. */
  onUpdate(cb: (status: unknown) => void) {
    const handler = (_e: IpcRendererEvent, status: unknown) => cb(status);
    ipcRenderer.on('aihub:update', handler);
    return () => ipcRenderer.removeListener('aihub:update', handler);
  },
});
