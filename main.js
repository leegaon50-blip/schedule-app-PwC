const { app, BrowserWindow, ipcMain, Notification, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { saveFinalSchedule, generateAttendanceRecords } = require('./services/scheduleService');
const { getDb } = require('./db/index');
const auditSvc = require('./services/auditService');

// Anaconda Python 우선, 없으면 시스템 python 사용
const _home = process.env.USERPROFILE || process.env.HOME || '';
const PYTHON_CANDIDATES = [
  path.join(_home, 'anaconda3', 'python.exe'),
  path.join(_home, 'anaconda3', 'envs', 'base', 'python.exe'),
  'python3',
  'python',
];

// Anaconda OpenSSL DLL 경로를 PATH에 추가 (SSL 오류 방지)
const ANACONDA_LIB = path.join(_home, 'anaconda3', 'Library', 'bin');
const spawnEnv = { ...process.env, PATH: ANACONDA_LIB + ';' + (process.env.PATH || '') };

// 감사 모니터용 spawn 환경 — 한글 파일명이 CP949로 깨지지 않도록 UTF-8 강제
const auditSpawnEnv = {
  ...spawnEnv,
  PYTHONIOENCODING: 'utf-8',  // stdin/stdout/stderr 인코딩 강제
  PYTHONUTF8: '1',             // Python 3.7+ UTF-8 모드 (파일·파이프 전체)
};

function runPython(args, stdinData = null) {
  const script = path.join(__dirname, 'scraper.py');
  const tryNext = (i) => new Promise((resolve, reject) => {
    if (i >= PYTHON_CANDIDATES.length) { reject(new Error('Python not found')); return; }
    const proc = spawn(PYTHON_CANDIDATES[i], [script, ...args], { env: spawnEnv });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (!out && code !== 0) { tryNext(i + 1).then(resolve).catch(reject); return; }
      try { resolve(JSON.parse(out || '{"ok":true}')); }
      catch(e) { reject(new Error(err || out || 'Python parse error')); }
    });
    proc.on('error', () => tryNext(i + 1).then(resolve).catch(reject));
    if (stdinData !== null) {
      proc.stdin.write(stdinData, 'utf8');
      proc.stdin.end();
    }
  });
  return tryNext(0);
}

// ── 감사 업무 — 엑셀 창 추적 & 미니 팝업 ────────────────────────────────────

const AUDIT_TIMEOUT_MS = 45 * 60 * 1000;   // 45분
const POPUP_W      = 300;   // 팝업 창 폭 (고정)
const POPUP_H      = 450;   // 팝업 창 높이 (일반 모드)
const POPUP_H_MINI = 44;    // 팝업 창 높이 (최소화 모드 — 타이틀바만)

// 감시 제외 키워드 — 파일명 또는 창 제목에 이 문자열이 포함된 엑셀 창은 팝업 대상에서 제외.
// 전기 조서·참고 파일 오작동 방지용. 항목 추가/제거는 이 배열만 수정하면 됨.
// (대소문자 구분 없이 비교 — '_PY' 하나로 '_py', '_Py' 모두 커버)
const AUDIT_EXCLUDE_KEYWORDS = ['_전기', '_PY', '_prior', '_2024'];

// hwnd → { sessionId, nodeId, title, deadline, notes, todos, popupWin }
const _auditPopups = new Map();

function _runAuditMonitor(stdinData) {
  const script = path.join(__dirname, 'audit_monitor.py');
  const tryNext = (i) => new Promise((resolve, reject) => {
    if (i >= PYTHON_CANDIDATES.length) {
      console.warn('[AuditMonitor] 사용 가능한 Python을 찾지 못했습니다.');
      resolve([]);
      return;
    }
    const proc = spawn(PYTHON_CANDIDATES[i], [script], { env: auditSpawnEnv });
    // Buffer로 수집 후 utf-8 디코딩 — 문자열 누적 시 Windows 기본 인코딩 혼입 방지
    const outBufs = [], errBufs = [];
    proc.stdout.on('data', d => { outBufs.push(d); });
    proc.stderr.on('data', d => { errBufs.push(d); });
    proc.on('close', code => {
      const out = Buffer.concat(outBufs).toString('utf8');
      const err = Buffer.concat(errBufs).toString('utf8');
      if (err) console.log('[AuditMonitor] py stderr:', err.trim());
      if (!out && code !== 0) {
        console.warn(`[AuditMonitor] ${PYTHON_CANDIDATES[i]} 실패(code=${code}), 다음 후보 시도`);
        tryNext(i + 1).then(resolve).catch(reject);
        return;
      }
      try { resolve(JSON.parse(out || '[]')); }
      catch (e) {
        console.error('[AuditMonitor] JSON 파싱 실패:', e.message, '| raw:', out.slice(0, 200));
        resolve([]);
      }
    });
    proc.on('error', (e) => {
      console.warn(`[AuditMonitor] spawn 오류(${PYTHON_CANDIDATES[i]}):`, e.message);
      tryNext(i + 1).then(resolve).catch(reject);
    });
    proc.stdin.write(stdinData, 'utf8');
    proc.stdin.end();
  });
  return tryNext(0);
}

// 파일을 방금 열었을 때 1.5초 간격 × 4회 추가 스캔을 예약
// (대용량 파일이 창을 완전히 활성화하기까지 최대 6초 대기)
function _scheduleRetryScans() {
  [1500, 3000, 4500, 6000].forEach(delay => setTimeout(_auditScan, delay));
}

async function _auditScan() {
  const mappings = auditSvc.getAllL4Mappings();
  if (!Object.keys(mappings).length) return;

  const payload = { mappings, exclude: AUDIT_EXCLUDE_KEYWORDS };
  console.log('[AuditScan] 전송 mappings:', Object.keys(mappings));

  let windows = [];
  try {
    windows = await _runAuditMonitor(JSON.stringify(payload));
    console.log('[AuditScan] 파이썬 감지 결과:', windows.length
      ? windows.map(w => `hwnd=${w.hwnd} title=${w.title}`)
      : '(없음)');
  } catch (e) {
    console.error('[AuditScan] _runAuditMonitor 예외:', e.message);
    return;
  }

  const now = Date.now();

  // 만료 체크
  for (const [hwnd, sess] of _auditPopups) {
    if (now >= sess.deadline) {
      await _expireAuditSession(hwnd);
    }
  }

  // 닫힌 창 정리 — 엑셀 종료 감지 시 todos 상태에 따라 done/pending 자동 분류
  const activeSet = new Set(windows.map(w => w.hwnd));
  for (const hwnd of [..._auditPopups.keys()]) {
    if (!activeSet.has(hwnd)) await _closeAuditPopupOnExcelExit(hwnd);
  }

  // 새 창 생성 / 위치 갱신 / 포커스 리셋
  for (const w of windows) {
    if (!_auditPopups.has(w.hwnd)) {
      await _createAuditPopup(w);
    } else {
      const sess = _auditPopups.get(w.hwnd);
      if (w.minimized) {
        // 엑셀 창이 최소화됨 — 팝업도 함께 숨김 (rect는 갱신하지 않음: 최소화 중엔
        // GetWindowRect가 화면 밖 좌표를 반환해 복원 시 위치가 틀어질 수 있음)
        if (sess.popupWin && !sess.popupWin.isDestroyed() && sess.popupWin.isVisible()) {
          sess.popupWin.hide();
        }
      } else {
        if (sess.popupWin && !sess.popupWin.isDestroyed() && !sess.popupWin.isVisible()) {
          sess.popupWin.show();
          sess.popupWin.setAlwaysOnTop(true, 'screen-saver');
        }
        _moveAuditPopup(w.hwnd, w.rect);
      }
    }
    if (w.focused && _auditPopups.has(w.hwnd)) {
      const s = _auditPopups.get(w.hwnd);
      s.deadline = Date.now() + AUDIT_TIMEOUT_MS;
      if (s.popupWin && !s.popupWin.isDestroyed()) {
        s.popupWin.webContents.send('audit-popup:deadline-reset',
          { remaining_ms: AUDIT_TIMEOUT_MS });
      }
    }
  }
}

async function _createAuditPopup(winInfo) {
  const { hwnd, title, rect, node_id, minimized } = winInfo;

  // 이 노드의 미완료 세션이 있으면 재개, 없으면 신규 생성
  const sessInfo  = auditSvc.getOrCreateActiveSession(node_id);
  const { sessionId, todos, notes, isResumed } = sessInfo;

  // 상단바 타이틀: 전체 경로에서 회사명(첫 번째)과 조서명(마지막)만 추출
  const nodePath   = auditSvc.getNodePath(node_id);
  const pathParts  = nodePath ? nodePath.split(' > ') : [];
  const popupTitle = pathParts.length >= 2
    ? `${pathParts[0]} > ${pathParts[pathParts.length - 1]}`
    : (nodePath || title);

  // 보류 → 활성으로 전환됐으면 pending 목록 즉시 갱신
  if (isResumed && mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('audit:pending-updated');
  }

  const [left, top, right, bottom] = rect;
  const x = Math.max(0, right  - POPUP_W - 12);
  const y = Math.max(0, bottom - POPUP_H - 12);

  const popupWin = new BrowserWindow({
    width: POPUP_W, height: POPUP_H,
    x, y,
    frame:        false,
    alwaysOnTop:  true,
    transparent:  true,
    skipTaskbar:  true,
    resizable:    false,
    focusable:    true,
    show:         false,   // did-finish-load에서 상태 보고 표시 (엑셀 최소화 상태면 숨김 유지)
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'renderer', 'auditPopupPreload.js'),
    },
  });
  popupWin.setMinimumSize(POPUP_W, POPUP_H_MINI);  // setBounds로 44px까지 줄일 수 있도록 허용
  popupWin.setMenuBarVisibility(false);
  popupWin.loadFile(path.join(__dirname, 'renderer', 'auditPopup.html'));

  popupWin.webContents.once('did-finish-load', () => {
    console.log(`[AuditPopup] 로드 완료 hwnd=${hwnd} (${x},${y}) sessionId=${sessionId} resumed=${isResumed}`);
    popupWin.webContents.send('audit-popup:init', {
      sessionId,
      title: popupTitle,
      remaining_ms: AUDIT_TIMEOUT_MS,
      todos,
      notes,
    });
    if (!minimized) {
      popupWin.show();
      popupWin.setAlwaysOnTop(true, 'screen-saver');
    }
  });

  // 팝업에 포커스가 오면 deadline 리셋
  popupWin.on('focus', () => {
    const sess = _auditPopups.get(hwnd);
    if (!sess) return;
    sess.deadline = Date.now() + AUDIT_TIMEOUT_MS;
    if (!popupWin.isDestroyed()) {
      popupWin.webContents.send('audit-popup:deadline-reset', { remaining_ms: AUDIT_TIMEOUT_MS });
    }
  });

  // 미니 모드에서 사용자가 타이틀바(-webkit-app-region: drag)를 직접 드래그해 옮기면
  // 이후로는 엑셀 창 추적(_moveAuditPopup)이 위치를 되돌리지 않도록 표시
  popupWin.on('moved', () => {
    const sess = _auditPopups.get(hwnd);
    if (!sess) return;
    if (sess.programmaticMove) { sess.programmaticMove = false; return; }
    sess.userMoved = true;
  });

  _auditPopups.set(hwnd, {
    sessionId, nodeId: node_id, title: popupTitle,
    deadline: Date.now() + AUDIT_TIMEOUT_MS,
    notes, todos,
    rect: [left, top, right, bottom],  // resize IPC에서 좌표 재계산용
    userMoved: false,          // 사용자가 직접 드래그해 옮겼는지 여부
    programmaticMove: false,   // 우리가 setBounds를 호출 중임을 표시 (moved 오검출 방지)
    popupWin,
  });
}

function _moveAuditPopup(hwnd, rect) {
  const sess = _auditPopups.get(hwnd);
  if (!sess?.popupWin || sess.popupWin.isDestroyed()) return;
  sess.rect = rect;  // Excel 창이 이동할 때 항상 최신 rect 보존 (드래그 해제 시 복귀용)
  if (sess.userMoved) return;  // 사용자가 직접 옮긴 뒤로는 자동 추적 중단, 위치 유지
  const [, , right, bottom] = rect;
  const [, curH] = sess.popupWin.getSize();   // 현재 높이 유지 (최소화 상태 보존)
  sess.programmaticMove = true;
  sess.popupWin.setBounds({
    x:      Math.max(0, right  - POPUP_W - 12),
    y:      Math.max(0, bottom - curH   - 12),
    width:  POPUP_W,
    height: curH,
  });
}

function _closeAuditPopup(hwnd) {
  const sess = _auditPopups.get(hwnd);
  if (!sess) return;
  if (sess.popupWin && !sess.popupWin.isDestroyed()) sess.popupWin.close();
  _auditPopups.delete(hwnd);
}

// 엑셀 창이 닫혔을 때 호출 — todos 완료 여부에 따라 done / pending 분기
async function _closeAuditPopupOnExcelExit(hwnd) {
  const sess = _auditPopups.get(hwnd);
  if (!sess) return;

  // 팝업 DOM에서 실시간 todos를 직접 읽어 캐시보다 정확한 최신 상태 사용
  let todos = sess.todos || [];
  if (sess.popupWin && !sess.popupWin.isDestroyed()) {
    try {
      todos = await sess.popupWin.webContents.executeJavaScript('_collectTodos()');
    } catch (e) {
      console.warn('[AuditPopup] executeJavaScript 실패, 캐시 todos 사용:', e.message);
    }
  }

  // 할 일이 1개 이상이고 전부 체크됐을 때만 완료 처리, 나머지는 모두 보류
  const allDone = todos.length > 0 && todos.every(t => t.done);

  if (allDone) {
    auditSvc.saveSessionContent(sess.sessionId, '', todos);
    auditSvc.completeSession(sess.sessionId);
    console.log(`[AuditPopup] 엑셀 종료 → 완료(done) sessionId=${sess.sessionId}`);
  } else {
    auditSvc.moveSessionToPending(sess.sessionId, '', todos);
    console.log(`[AuditPopup] 엑셀 종료 → 보류(pending) sessionId=${sess.sessionId} todos=${todos.length}`);
  }

  if (sess.popupWin && !sess.popupWin.isDestroyed()) sess.popupWin.close();
  _auditPopups.delete(hwnd);

  auditSvc.saveAuditSnapshotToDisk();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('audit:pending-updated');
  }
}

async function _expireAuditSession(hwnd) {
  const sess = _auditPopups.get(hwnd);
  if (!sess) return;

  auditSvc.moveSessionToPending(sess.sessionId, sess.notes, sess.todos);

  const parts   = (sess.title || '').split(' > ');
  const company = parts[0] || '';
  const task    = parts[parts.length - 1] || sess.title;

  if (Notification.isSupported()) {
    new Notification({
      title: '업무 자동 보류 알림',
      body:  `[${company} - ${task}] 작업이 45분간 입력이 없어 '진행 중인 작업'으로 안전하게 저장되었습니다.`,
    }).show();
  }

  if (sess.popupWin && !sess.popupWin.isDestroyed()) {
    sess.popupWin.webContents.send('audit-popup:expired');
    // 팝업이 스스로 3초 후 window.close()를 호출하므로 5초 폴백만 유지
    setTimeout(() => {
      if (!sess.popupWin.isDestroyed()) sess.popupWin.close();
    }, 5000);
  }

  _auditPopups.delete(hwnd);

  auditSvc.saveAuditSnapshotToDisk();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('audit:pending-updated');
  }
}

// ── 감사 IPC 핸들러 ───────────────────────────────────────────────────────────

ipcMain.handle('audit:getChildren', (_, parentId) =>
  auditSvc.getChildren(parentId === undefined ? null : parentId));

ipcMain.handle('audit:getNode', (_, id) => auditSvc.getNode(id));

ipcMain.handle('audit:addNode', (_, parentId, level, name, excelPath) =>
  auditSvc.addNode(parentId, level, name, excelPath));

ipcMain.handle('audit:updateNode', (_, id, name, excelPath) =>
  auditSvc.updateNode(id, name, excelPath));

ipcMain.handle('audit:deleteNode', (_, id) => auditSvc.deleteNode(id));

ipcMain.handle('audit:getNodePath', (_, id) => auditSvc.getNodePath(id));

ipcMain.handle('audit:getPending',  ()      => auditSvc.getPendingSessions());

ipcMain.handle('audit:getSession',  (_, id) => auditSvc.getSession(id));

ipcMain.handle('audit:pickExcel', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '감사 엑셀 파일 선택',
    filters: [{ name: 'Excel', extensions: ['xlsx','xlsm','xls','xlsb'] }],
    properties: ['openFile'],
  });
  return canceled || !filePaths.length ? null : filePaths[0];
});

// 팝업 창 크기 토글 (최소화 ↔ 일반)
// CSS height: 100% 이므로 물리적 창 높이가 곧 카드 높이가 됨
ipcMain.handle('audit-popup:resize', (event, { minimized }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;

  // 이 팝업의 세션에서 Excel 창 rect를 꺼내 위치 재계산
  let sess = null;
  for (const s of _auditPopups.values()) {
    if (s.popupWin === win) { sess = s; break; }
  }

  const h = minimized ? POPUP_H_MINI : POPUP_H;

  if (sess) sess.programmaticMove = true;

  if (sess?.rect && !sess.userMoved) {
    const [, , right, bottom] = sess.rect;
    win.setBounds({
      x:      Math.max(0, right  - POPUP_W - 12),
      y:      Math.max(0, bottom - h       - 12),
      width:  POPUP_W,
      height: h,
    });
  } else {
    // 사용자가 직접 옮긴 위치(또는 rect 없음) — 현재 위치는 유지하고 높이만 변경
    const [cx, cy] = win.getPosition();
    win.setBounds({ x: cx, y: cy, width: POPUP_W, height: h });
  }
});

// 팝업에서 내용 변경 시 메인 프로세스 캐시 + DB 갱신
// flushSave() 호출마다 여기 도달 — 디바운스(800ms)로 스냅샷 과다 쓰기 방지
let _snapshotDebounceTimer = null;
ipcMain.on('audit-popup:save', (_, { sessionId, notes, todos }) => {
  auditSvc.saveSessionContent(sessionId, notes, todos);
  for (const sess of _auditPopups.values()) {
    if (sess.sessionId === sessionId) {
      sess.notes = notes;
      sess.todos = todos;
    }
  }
  if (_snapshotDebounceTimer) clearTimeout(_snapshotDebounceTimer);
  _snapshotDebounceTimer = setTimeout(() => {
    auditSvc.saveAuditSnapshotToDisk();
    _snapshotDebounceTimer = null;
  }, 800);
});

// 팝업에서 [업무 완료] 버튼 클릭 시
ipcMain.on('audit-popup:done', (_, { sessionId, todos }) => {
  auditSvc.saveSessionContent(sessionId, '', todos);
  auditSvc.completeSession(sessionId);
  for (const [hwnd, sess] of _auditPopups) {
    if (sess.sessionId === sessionId) {
      _closeAuditPopup(hwnd);
      break;
    }
  }
  auditSvc.saveAuditSnapshotToDisk();
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('audit:pending-updated');
  }
});

// 렌더러에서 세션 상태 변경 요청
ipcMain.handle('audit:resumeSession',     (_, id)     => { auditSvc.resumeSession(id);             return true; });
ipcMain.handle('audit:restoreToPending',  (_, id)     => {
  auditSvc.restoreToPending(id);
  auditSvc.saveAuditSnapshotToDisk();
  return true;
  // pending-updated 이벤트는 보내지 않음 — 호출측(_auditRestoreDone)이 직접 렌더 처리
});
ipcMain.handle('audit:completeSession',   (_, id)     => { auditSvc.completeSession(id);  auditSvc.saveAuditSnapshotToDisk(); return true; });
ipcMain.handle('audit:deleteSession',     (_, id)     => { auditSvc.deleteSession(id);    auditSvc.saveAuditSnapshotToDisk(); return true; });
ipcMain.handle('audit:getDone',           ()          => auditSvc.getDoneSessions());
ipcMain.handle('audit:completeAllUnder',  (_, nodeId) => { auditSvc.completeAllSessionsUnder(nodeId); auditSvc.saveAuditSnapshotToDisk(); return true; });

ipcMain.handle('audit:getRequestItems', () => auditSvc.getRequestItems());

ipcMain.handle('audit:updateTodoText', (_, { sessionId, oldText, newText }) => {
  const ok = auditSvc.updateTodoText(sessionId, oldText, newText);
  if (ok) auditSvc.saveAuditSnapshotToDisk();
  return ok;
});

ipcMain.handle('audit:getAllNodes',    () => auditSvc.getAllNodes());
ipcMain.handle('audit:getKanbanData', () => auditSvc.getKanbanData());

// 렌더러에서 직접 디스크 스냅샷 쓰기 트리거 (audit:saveSnapshot)
ipcMain.handle('audit:saveSnapshot',  () => auditSvc.saveAuditSnapshotToDisk());

// [재개하기] 버튼 — 세션 상태를 즉시 변경하지 않고 Excel만 자동 실행
// pending 세션: 상태 유지 → _auditScan이 Excel 창 감지 시 자동 active 전환
// done 세션: pending으로 전환 후 Excel 실행 → 이후 동일 흐름
ipcMain.handle('audit:resumeAndOpen', async (_, { sessionId, isDone }) => {
  const sess = auditSvc.getSession(sessionId);
  if (!sess) return { ok: false, error: '세션 정보를 찾을 수 없습니다.' };

  const node = auditSvc.getNode(sess.node_id);
  let filePath = node?.excel_path;
  if (!filePath) {
    return { ok: false, error: '연동된 엑셀 파일 경로가 없습니다.\n해당 조서의 엑셀 파일을 트리에서 다시 연동해 주세요.' };
  }

  // 파일 경로 변경·이동 방어: 파일이 없으면 재탐색 다이얼로그
  if (!fs.existsSync(filePath)) {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '이동된 엑셀 파일 다시 찾기',
      message: `"${path.basename(filePath)}"을(를) 찾을 수 없습니다.\n이동 또는 이름이 변경된 파일을 직접 선택해 주세요.`,
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm', 'xls', 'xlsb'] }],
      properties: ['openFile'],
      defaultPath: path.dirname(filePath),
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    filePath = filePaths[0];
    auditSvc.updateNode(sess.node_id, node?.name || '', filePath);
  }

  if (isDone) {
    auditSvc.moveSessionToPending(sessionId, sess.notes || '', sess.todos);
  }

  const err = await shell.openPath(filePath);
  if (err) return { ok: false, error: err };
  _scheduleRetryScans();
  return { ok: true, changedToPending: isDone };
});

ipcMain.handle('audit:open-excel', async (_, { filePath, nodeId }) => {
  // 파일이 존재하면 즉시 열기
  if (filePath && fs.existsSync(filePath)) {
    const err = await shell.openPath(filePath);
    if (err) return { ok: false, error: err };
    _scheduleRetryScans();
    return { ok: true };
  }

  // 파일 없음 — nodeId가 없으면 단순 에러 반환 (경로 복구 불가)
  if (!nodeId) {
    return { ok: false, error: '파일을 찾을 수 없습니다. 트리에서 🔗 버튼으로 재연결해 주세요.' };
  }

  // 재탐색 다이얼로그로 새 경로 안내
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '이동된 엑셀 파일 다시 찾기',
    message: `"${path.basename(filePath || '')}"을(를) 찾을 수 없습니다.\n이동 또는 이름이 변경된 파일을 직접 선택해 주세요.`,
    filters: [{ name: 'Excel', extensions: ['xlsx', 'xlsm', 'xls', 'xlsb'] }],
    properties: ['openFile'],
    defaultPath: filePath ? path.dirname(filePath) : undefined,
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };

  const newPath = filePaths[0];
  const node    = auditSvc.getNode(nodeId);
  auditSvc.updateNode(nodeId, node?.name || '', newPath);

  const err = await shell.openPath(newPath);
  if (err) return { ok: false, error: err };
  _scheduleRetryScans();
  return { ok: true, newPath };
});

// ── (끝) 감사 업무 ─────────────────────────────────────────────────────────────

app.name = '일정 관리';
if (process.platform === 'win32') app.setAppUserModelId('일정 관리');

const JOBS_FILE = path.join(__dirname, 'kicpa_jobs.json');
const KICPA_NAV_URL = 'https://www.kicpa.or.kr/portal/default/kicpa/gnb/kr_pc/menu05/menu09.page';
const GDRIVE_FOLDER = process.env.SCHEDULE_GDRIVE_FOLDER || 'G:\\내 드라이브\\schedule_app_files';
const KICPA_EXTERNAL_URL = 'https://www.kicpa.or.kr/portal/default/kicpa/gnb/kr_pc/menu05/menu09.page';
const KICPA_DETAIL_URL = 'https://www.kicpa.or.kr/home/jobOffrSrchNewGnrl/detail.face';
const CHECK_INTERVAL = 30 * 60 * 1000;

let mainWin = null;
let cachedJobs = [];
let seenIds = new Set();
let lastChecked = null;
let isFetching = false;
let jobsListUrl = null;

const collectFrames = (frame) => {
  const list = [frame];
  for (const child of (frame.frames || [])) list.push(...collectFrames(child));
  return list;
};

function loadJobData() {
  try {
    const d = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    cachedJobs = d.jobs || [];
    seenIds = new Set(d.seenIds || []);
    lastChecked = d.lastChecked || null;
    jobsListUrl = d.jobsListUrl || null;
  } catch(e) {}
}

function saveJobData() {
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); } catch(e) {}
    fs.writeFileSync(JOBS_FILE, JSON.stringify({
      jobs: cachedJobs,
      seenIds: [...seenIds],
      lastChecked,
      jobsListUrl,
      pendingJobs:       existing.pendingJobs       || [],
      lastJobNotifiedAt: existing.lastJobNotifiedAt || '',
    }), 'utf8');
  } catch(e) {}
}

async function scrapeJobs() {
  if (isFetching) return null;
  isFetching = true;
  try {
    const jobs = await runPython(['list']);
    if (Array.isArray(jobs)) return jobs;
    return null;
  } catch(e) {
    return null;
  } finally {
    isFetching = false;
  }
}

async function checkJobs() {
  const jobs = await scrapeJobs();
  if (jobs === null) {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('jobs-updated', { jobs: cachedJobs, newIds: [], lastChecked, error: true });
    }
    return;
  }

  lastChecked = new Date().toLocaleString('ko-KR');

  const isFirstRun = seenIds.size === 0;
  const newIds = isFirstRun ? [] : jobs.filter(j => !seenIds.has(j.bltnNo) && !seenIds.has(j.id)).map(j => j.id);

  jobs.forEach(j => { seenIds.add(j.bltnNo || j.id); });
  cachedJobs = jobs;
  saveJobData();

  if (!isFirstRun && newIds.length > 0) {
    const newJobs = jobs.filter(j => newIds.includes(j.id));

    if (Notification.isSupported()) {
      const notif = new Notification({
        title: `KICPA 새 구인공고 ${newIds.length}건`,
        body: newJobs.slice(0, 3).map(j => j.title).join('\n'),
      });
      notif.on('click', () => {
        if (mainWin && !mainWin.isDestroyed()) {
          mainWin.show();
          mainWin.focus();
          mainWin.webContents.send('show-jobs-tab');
        }
      });
      notif.show();
    }

  }

  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('jobs-updated', { jobs, newIds, lastChecked, error: false });
  }
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 960,
    height: 780,
    minWidth: 700,
    minHeight: 500,
    title: '일정 관리',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#f5f5f3',
      symbolColor: '#666666',
      height: 28,
    },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // UA에 ScheduleApp 토큰 삽입 — loadFile·loadURL 모두에서 프론트엔드가
  // navigator.userAgent 로 Electron 환경을 확실하게 감지할 수 있게 한다.
  mainWin.webContents.setUserAgent(
    mainWin.webContents.getUserAgent() + ' ScheduleApp/1.0'
  );
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.setMenuBarVisibility(false);
  mainWin.on('closed', () => { mainWin = null; });
}

ipcMain.on('set-window-mode', (event, mode) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (mode === 'mini') {
    win.setMinimumSize(220, 300);
    win.setMaximumSize(420, 900);
    win.setSize(280, 480);
    win.setAlwaysOnTop(true);
    win.setTitleBarOverlay({ color: '#f5f5f3', symbolColor: '#666666', height: 28 });
  } else {
    win.setAlwaysOnTop(false);
    win.setMaximumSize(9999, 9999);
    win.setMinimumSize(700, 500);
    win.setSize(960, 780);
    win.setTitleBarOverlay({ color: '#f5f5f3', symbolColor: '#666666', height: 28 });
  }
});

ipcMain.on('get-jobs', () => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('jobs-updated', { jobs: cachedJobs, newIds: [], lastChecked, error: false });
  }
  checkJobs();
});

ipcMain.on('open-external', (_, url) => {
  shell.openExternal(url);
});

ipcMain.handle('attach-file', async () => {
  const { canceled, filePaths: selected } = await dialog.showOpenDialog({
    title: '파일 첨부',
    properties: ['openFile'],
  });
  if (canceled || !selected.length) return null;
  const src = selected[0];
  try {
    if (!fs.existsSync(GDRIVE_FOLDER)) fs.mkdirSync(GDRIVE_FOLDER, { recursive: true });
    const dest = path.join(GDRIVE_FOLDER, path.basename(src));
    fs.copyFileSync(src, dest);
    return dest;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.on('open-file', (_, filePath) => {
  shell.openPath(filePath);
});

ipcMain.on('open-job', (_, bltnNo) => {
  const safeId = String(bltnNo).replace(/[^0-9]/g, '');
  if (!safeId) return;

  const postBody = new URLSearchParams({
    ijIdNum: safeId,
    listCnt: '20', page: '1', srhType: '', srhKey: '',
    searchIjArea: '1800', searchArea: '18',
    ijCareer: '-1', ijLastschool: '-1', ijPay: '-1',
    ijEmpSep: 'all', ijCoSep: '-1', searchAreaBack: '00',
    ijJobSep: '8', ijIntId: '', ijWname: '',
  }).toString();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'KICPA 구인공고',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

  win.webContents.loadURL(KICPA_DETAIL_URL, {
    postData: [{ type: 'rawData', bytes: Buffer.from(postBody) }],
    extraHeaders: 'Content-Type: application/x-www-form-urlencoded\n',
  });
});

ipcMain.handle('get-job-deadline', async (_, bltnNo) => {
  try {
    const result = await runPython(['deadline', String(bltnNo)]);
    return { deadline: result.deadline || null, deadline_raw: result.deadline_raw || null };
  } catch(e) {
    return { deadline: null, deadline_raw: null };
  }
});

// ── OCR 시간표 등록 IPC ───────────────────────────────────────────────────────

const _ocrDrafts   = new Map();
let   _nextDraftId = 0;

ipcMain.handle('get-active-semester', async () => {
  try {
    const db  = getDb();
    const row = db.prepare(
      'SELECT * FROM Semester WHERE isActive = 1 ORDER BY id DESC LIMIT 1'
    ).get();
    return row
      ? { ok: true,  data: row }
      : { ok: false, error: '활성 학기가 없습니다. 먼저 학기를 추가해 주세요.' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-ocr-draft', async (_, { semesterId, draftData }) => {
  try {
    const id = ++_nextDraftId;
    _ocrDrafts.set(id, { semesterId, draftData, at: new Date().toISOString() });
    return { ok: true, draftId: id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('save-final-schedule', async (_, { semesterId, parsedLectures, draftId }) => {
  try {
    const result = saveFinalSchedule(semesterId, parsedLectures);
    generateAttendanceRecords(semesterId);
    if (draftId != null) _ocrDrafts.delete(draftId);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-job-stages', async (_, bltnNo) => {
  try {
    const result = await runPython(['stages', String(bltnNo)]);
    return {
      stages:       result.stages       || [],
      deadline:     result.deadline     || null,
      deadline_raw: result.deadline_raw || null,
    };
  } catch(e) {
    return { stages: [], deadline: null, deadline_raw: null };
  }
});

app.whenReady().then(() => {
  loadJobData();
  createWindow();

  setTimeout(checkJobs, 1000);
  setInterval(checkJobs, CHECK_INTERVAL);

  // 감사 업무 엑셀 창 모니터링 (2초 주기)
  setInterval(_auditScan, 2000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});