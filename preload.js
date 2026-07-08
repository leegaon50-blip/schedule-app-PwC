const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  setWindowMode: (mode) => ipcRenderer.send('set-window-mode', mode),
  getJobs: () => ipcRenderer.send('get-jobs'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  openJob: (bltnNo) => ipcRenderer.send('open-job', bltnNo),
  getJobDeadline: (bltnNo) => ipcRenderer.invoke('get-job-deadline', bltnNo),
  onJobsUpdated: (cb) => ipcRenderer.on('jobs-updated', (_, data) => cb(data)),
  onShowJobsTab: (cb) => ipcRenderer.on('show-jobs-tab', () => cb()),
  getJobStages: (bltnNo) => ipcRenderer.invoke('get-job-stages', bltnNo),
  attachFile: () => ipcRenderer.invoke('attach-file'),
  openFile: (filePath) => ipcRenderer.send('open-file', filePath),
  getActiveSemester: () => ipcRenderer.invoke('get-active-semester'),
  saveOcrDraft: (payload) => ipcRenderer.invoke('save-ocr-draft', payload),
  saveFinalSchedule: (payload) => ipcRenderer.invoke('save-final-schedule', payload),

  // ── 감사 업무 관리 ──────────────────────────────────────────────────────────
  audit: {
    getChildren:      (parentId)           => ipcRenderer.invoke('audit:getChildren', parentId),
    getNode:          (id)                 => ipcRenderer.invoke('audit:getNode', id),
    addNode:          (p, l, n, e)         => ipcRenderer.invoke('audit:addNode', p, l, n, e),
    updateNode:       (id, n, e)           => ipcRenderer.invoke('audit:updateNode', id, n, e),
    deleteNode:       (id)                 => ipcRenderer.invoke('audit:deleteNode', id),
    getNodePath:      (id)                 => ipcRenderer.invoke('audit:getNodePath', id),
    pickExcel:        ()                   => ipcRenderer.invoke('audit:pickExcel'),
    getPending:       ()                   => ipcRenderer.invoke('audit:getPending'),
    getDone:          ()                   => ipcRenderer.invoke('audit:getDone'),
    getSession:       (id)                 => ipcRenderer.invoke('audit:getSession', id),
    resumeSession:    (id)                 => ipcRenderer.invoke('audit:resumeSession', id),
    restoreToPending: (id)                 => ipcRenderer.invoke('audit:restoreToPending', id),
    completeSession:  (id)                 => ipcRenderer.invoke('audit:completeSession', id),
    deleteSession:    (id)                 => ipcRenderer.invoke('audit:deleteSession', id),
    openExcel:        (filePath, nodeId)   => ipcRenderer.invoke('audit:open-excel', { filePath, nodeId }),
    resumeAndOpen:     (sessionId, isDone)  => ipcRenderer.invoke('audit:resumeAndOpen', { sessionId, isDone }),
    completeAllUnder:  (nodeId)            => ipcRenderer.invoke('audit:completeAllUnder', nodeId),
    onPendingUpdated:  (cb)                => {
      ipcRenderer.removeAllListeners('audit:pending-updated');
      ipcRenderer.on('audit:pending-updated', () => cb());
    },
    getRequestItems:   ()                  => ipcRenderer.invoke('audit:getRequestItems'),
    updateTodoText:    (sessionId, oldText, newText) =>
      ipcRenderer.invoke('audit:updateTodoText', { sessionId, oldText, newText }),
    getAllNodes:        ()                  => ipcRenderer.invoke('audit:getAllNodes'),
    getKanbanData:      ()                  => ipcRenderer.invoke('audit:getKanbanData'),
    saveSnapshot:       ()                  => ipcRenderer.invoke('audit:saveSnapshot'),
  },
});
