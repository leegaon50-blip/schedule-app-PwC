'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popupAPI', {
  // main → popup: 초기 데이터 (세션 정보 + 남은 시간)
  onInit:          (cb) => ipcRenderer.on('audit-popup:init',           (_, d) => cb(d)),
  // main → popup: 포커스 감지 시 타이머 리셋
  onDeadlineReset: (cb) => ipcRenderer.on('audit-popup:deadline-reset', (_, d) => cb(d)),
  // main → popup: 45분 만료
  onExpired:       (cb) => ipcRenderer.once('audit-popup:expired',      ()    => cb()),
  // popup → main: 체크리스트 변경 시 저장 (notes는 항상 '')
  saveContent: (sessionId, todos) =>
    ipcRenderer.send('audit-popup:save', { sessionId, notes: '', todos }),
  // popup → main: 사용자가 [업무 완료] 버튼을 눌렀을 때
  markDone: (sessionId, todos) =>
    ipcRenderer.send('audit-popup:done', { sessionId, todos }),
  // popup → main: 창 최소화 / 복원 (BrowserWindow 크기 조절)
  resizeWindow: (minimized) =>
    ipcRenderer.invoke('audit-popup:resize', { minimized }),
});
