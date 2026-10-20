import type { DesktopAPI, Frame, Snapshot } from '../shared/model'
import { contextBridge, ipcRenderer } from 'electron'

const api: DesktopAPI = {
  snapshot: () => ipcRenderer.invoke('octo:snapshot'),
  script: (id) => ipcRenderer.invoke('octo:script', id),
  installDependencies: (id) => ipcRenderer.invoke('octo:install-deps', id),
  scriptRuns: (id) => ipcRenderer.invoke('octo:script-runs', id),
  taskRuns: (id) => ipcRenderer.invoke('octo:task-runs', id),
  notification: (id) => ipcRenderer.invoke('octo:notification', id),
  notificationLogs: (query) => ipcRenderer.invoke('octo:notification-logs', query),
  dataRecords: (query) => ipcRenderer.invoke('octo:data-records', query),
  captureQuery: (query) => ipcRenderer.invoke('octo:capture-query', query),
  captureDetail: (id) => ipcRenderer.invoke('octo:capture-detail', id),
  captureView: (bounds) => ipcRenderer.invoke('octo:capture-view', bounds),
  command: (command) => ipcRenderer.invoke('octo:command', command),
  cookies: (id) => ipcRenderer.invoke('octo:cookies', id),
  secret: (request) => ipcRenderer.invoke('octo:secret', request),
  acknowledge: (frame) => ipcRenderer.send('octo:ack', frame),
  onState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Snapshot) => listener(snapshot)
    ipcRenderer.on('octo:state', handler)
    return () => { ipcRenderer.removeListener('octo:state', handler) }
  },
  onFrame(listener) {
    const handler = (_event: Electron.IpcRendererEvent, frame: Frame) => listener(frame)
    ipcRenderer.on('octo:frame', handler)
    return () => { ipcRenderer.removeListener('octo:frame', handler) }
  }
}
contextBridge.exposeInMainWorld('octo', api)
