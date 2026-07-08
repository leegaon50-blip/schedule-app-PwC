'use strict';
// renderer/auditView.js — 감사 업무 탭 UI (4단계 트리 + Pending 백로그 + 완료 목록)

const AUDIT_L2 = ['조서 작업', '주석 검토', '타이아웃', '클라라 작업'];
const AUDIT_ICON = { 1: '🏢', 2: '📂', 3: '📁', 4: '📄' };
const AUDIT_LABEL = { 1: '회사명', 2: '업무 대분류', 3: '중분류', 4: '세부 업무명' };

let _auditInitialized = false;
let _modalSessionId = null;
let _currentAuditView  = 'tree'; // 'tree' | 'kanban'
let _currentKanbanSort = 'asc';  // 'asc' | 'desc'
let _pendingUpdDebounce = null;  // onPendingUpdated 디바운스 타이머

function _isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function _isElectronEnv() {
  return !!(window.electronAPI?.isElectron) ||
    navigator.userAgent.includes('ScheduleApp/');
}

// ── 탭 진입 시 호출 ───────────────────────────────────────────────────────────

async function initAuditTab() {
  if (window.isReadOnlyEnv) {
    const panel = document.getElementById('panel-audit');
    if (panel) {
      panel.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
                    min-height:320px;padding:40px 24px;text-align:center">
          <div style="font-size:52px;margin-bottom:20px">🔒</div>
          <div style="font-size:15px;font-weight:600;color:var(--text);line-height:1.8;max-width:380px">
            본 기능은 회계법인 및 클라이언트 보안 규정에 따라<br>
            데스크탑(Electron) 환경에서만 접근이 가능합니다.
          </div>
        </div>`;
    }
    return;
  }
  if (!window.electronAPI?.audit) {
    setTimeout(initAuditTab, 300);
    return;
  }
  _ensureModalAndStyles();
  _ensureDoneSection();
  if (!_auditInitialized) {
    // removeAllListeners는 preload에서 처리하므로 여기서는 단순 등록
    window.electronAPI.audit.onPendingUpdated(() => {
      // 50ms 디바운스: 동일 이벤트 루프에서 중복 발사되는 pending-updated를 1회로 압축
      if (_pendingUpdDebounce) clearTimeout(_pendingUpdDebounce);
      _pendingUpdDebounce = setTimeout(() => {
        _pendingUpdDebounce = null;
        renderAuditPending();
        renderAuditDoneTree();
        const reqPanel = document.getElementById('audit-request-panel');
        if (reqPanel && reqPanel.style.display !== 'none') renderAuditRequestDashboard();
        if (_currentAuditView === 'kanban') renderAuditKanbanBoard();
      }, 50);
    });
    _auditInitialized = true;
  }
  await Promise.all([renderAuditTree(), renderAuditPending(), renderAuditDoneTree()]);
}

// ── 커스텀 입력 모달 (prompt() 대체) ─────────────────────────────────────────

/**
 * Electron에서 prompt()가 지원되지 않으므로 커스텀 입력 모달로 대체.
 *
 * @param {string}   label        - 입력 창 상단에 표시할 안내 문구
 * @param {string}   defaultValue - 텍스트 필드 초깃값
 * @param {string[]} [options]    - 칩 버튼으로 표시할 선택지 (L2 피커 등)
 * @returns {Promise<string|null>} - 확인 시 입력값(string), 취소 시 null
 */
function _showPrompt(label, defaultValue = '', options = null) {
  return new Promise((resolve) => {
    const modal    = document.getElementById('audit-input-modal');
    const labelEl  = document.getElementById('audit-input-label');
    const chipsEl  = document.getElementById('audit-input-chips');
    const input    = document.getElementById('audit-input-field');
    const okBtn    = document.getElementById('audit-input-ok-btn');
    const cancelBtn = document.getElementById('audit-input-cancel-btn');

    // 레이블
    labelEl.textContent = label;

    // 선택지 칩 (L2 피커 등)
    chipsEl.innerHTML = '';
    chipsEl.style.display = options?.length ? 'flex' : 'none';

    if (options?.length) {
      for (const opt of options) {
        const chip = document.createElement('button');
        chip.className = 'audit-chip';
        chip.type = 'button';
        chip.textContent = opt;
        chip.onclick = () => {
          chipsEl.querySelectorAll('.audit-chip').forEach(c => c.classList.remove('selected'));
          chip.classList.add('selected');
          input.value = '';
        };
        chipsEl.appendChild(chip);
      }
      input.placeholder = '또는 직접 입력…';
      // 직접 입력 시 칩 선택 해제
      input.oninput = () => {
        if (input.value) chipsEl.querySelectorAll('.audit-chip').forEach(c => c.classList.remove('selected'));
      };
    } else {
      input.placeholder = '';
      input.oninput = null;
    }

    input.value = defaultValue;
    modal.classList.add('open');
    setTimeout(() => { input.focus(); if (defaultValue) input.select(); }, 30);

    const finish = (value) => {
      modal.classList.remove('open');
      okBtn.onclick     = null;
      cancelBtn.onclick = null;
      input.onkeydown   = null;
      modal.onclick     = null;
      resolve(value);
    };

    okBtn.onclick = () => {
      if (options?.length) {
        const sel = chipsEl.querySelector('.audit-chip.selected');
        if (sel) { finish(sel.textContent); return; }
      }
      const val = input.value.trim();
      finish(val || null);
    };

    cancelBtn.onclick = () => finish(null);
    modal.onclick = (e) => { if (e.target === modal) finish(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); okBtn.click(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
  });
}

// ── 모달 & 스타일 DOM 주입 (최초 1회) ────────────────────────────────────────

function _ensureModalAndStyles() {
  if (document.getElementById('audit-session-modal')) return;

  const s = document.createElement('style');
  s.textContent = `
    /* ── 세션 상세 모달 ──────────────────────────────────────── */
    #audit-session-modal {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.45); z-index: 9999;
      align-items: center; justify-content: center;
    }
    #audit-session-modal.open { display: flex; }
    .audit-modal-card {
      background: #fff; border-radius: 12px;
      width: 440px; max-height: 80vh;
      display: flex; flex-direction: column;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      overflow: hidden;
    }
    .audit-modal-hdr {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 14px 16px 10px;
      border-bottom: 1px solid #f0f0ee; flex-shrink: 0;
    }
    .audit-modal-path {
      flex: 1; font-size: 13px; font-weight: 600; color: #1a1a1a; line-height: 1.4;
    }
    .audit-modal-close {
      background: none; border: none; font-size: 20px; color: #aaa;
      cursor: pointer; padding: 0 2px; line-height: 1; flex-shrink: 0;
    }
    .audit-modal-close:hover { color: #333; }
    .audit-modal-meta {
      font-size: 11px; color: #aaa; padding: 6px 16px;
      border-bottom: 1px solid #f5f5f3; flex-shrink: 0;
    }
    .audit-modal-todos { flex: 1; overflow-y: auto; padding: 8px 16px; }
    .audit-modal-todo-row {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 5px 0; border-bottom: 1px solid #f5f5f3;
      font-size: 13px; color: #333; line-height: 1.4;
    }
    .audit-modal-todo-row:last-child { border-bottom: none; }
    .audit-modal-todo-check { flex-shrink: 0; margin-top: 1px; }
    .audit-modal-todo-text.done { text-decoration: line-through; color: #aaa; }
    .audit-modal-empty { padding: 20px; text-align: center; color: #aaa; font-size: 13px; }
    .audit-modal-footer {
      display: flex; gap: 8px; padding: 12px 16px;
      border-top: 1px solid #f0f0ee; flex-shrink: 0;
    }
    .audit-btn-resume {
      flex: 1; padding: 9px 0; border-radius: 8px;
      background: #5b5bd6; color: #fff; border: none;
      font-size: 13px; font-weight: 500; cursor: pointer;
    }
    .audit-btn-resume:hover { background: #4a4ac5; }
    .audit-btn-complete {
      flex: 1; padding: 9px 0; border-radius: 8px;
      background: #22c55e; color: #fff; border: none;
      font-size: 13px; font-weight: 500; cursor: pointer;
    }
    .audit-btn-complete:hover { background: #16a34a; }

    /* ── 커스텀 입력 모달 (prompt 대체) ─────────────────────── */
    #audit-input-modal {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.45); z-index: 10001;
      align-items: center; justify-content: center;
    }
    #audit-input-modal.open { display: flex; }
    .audit-input-card {
      background: #fff; border-radius: 12px;
      width: 340px; padding: 20px 20px 16px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.2);
      display: flex; flex-direction: column; gap: 12px;
    }
    #audit-input-label {
      font-size: 14px; font-weight: 600; color: #1a1a1a; line-height: 1.5;
    }
    #audit-input-chips {
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .audit-chip {
      padding: 6px 13px; border-radius: 20px;
      border: 1.5px solid #e0e0dc;
      background: #fff; font-size: 13px; cursor: pointer;
      font-family: inherit; transition: all 0.15s; color: #333;
    }
    .audit-chip:hover  { border-color: #5b5bd6; color: #5b5bd6; }
    .audit-chip.selected {
      background: #5b5bd6; border-color: #5b5bd6;
      color: #fff; font-weight: 500;
    }
    #audit-input-field {
      width: 100%; border: 1.5px solid #e0e0dc;
      border-radius: 8px; padding: 8px 10px;
      font-size: 14px; outline: none;
      font-family: inherit; color: #1a1a1a;
      transition: border-color 0.15s;
    }
    #audit-input-field:focus  { border-color: #5b5bd6; }
    #audit-input-field::placeholder { color: #bbb; }
    .audit-input-footer {
      display: flex; gap: 8px; justify-content: flex-end; margin-top: 2px;
    }
    #audit-input-cancel-btn {
      padding: 8px 16px; border-radius: 8px;
      background: #f5f5f3; border: 1px solid #e0e0dc;
      font-size: 13px; cursor: pointer; font-family: inherit; color: #555;
    }
    #audit-input-cancel-btn:hover { background: #ebebea; }
    #audit-input-ok-btn {
      padding: 8px 20px; border-radius: 8px;
      background: #5b5bd6; color: #fff; border: none;
      font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit;
    }
    #audit-input-ok-btn:hover { background: #4a4ac5; }

    /* ── 완료 섹션 ───────────────────────────────────────────── */
    .audit-done-section { margin-top: 18px; }
    .audit-done-hdr {
      display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;
    }
    .audit-done-hdr h3 { font-size: 14px; font-weight: 600; color: #888; }
    .audit-done-list {
      border: 1px solid #e0e0dc; border-radius: 10px;
      overflow: hidden; min-height: 40px;
    }
    .audit-done-card {
      padding: 8px 12px; border-bottom: 1px solid #f0f0ee;
      cursor: pointer; transition: background 0.1s;
      display: flex; align-items: center; gap: 8px;
    }
    .audit-done-card:last-child { border-bottom: none; }
    .audit-done-card:hover { background: #fafaf8; }
    .audit-done-card-info { flex: 1; min-width: 0; }
    .audit-done-card-path {
      font-size: 12px; color: #888; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
    }
    .audit-done-card-meta { font-size: 11px; color: #bbb; margin-top: 1px; }
    .audit-done-check-icon { color: #22c55e; font-size: 15px; flex-shrink: 0; }

    /* ── 완료 작업 계층 트리 ────────────────────────────────── */
    .audit-done-icon { color: #16a34a !important; font-style: normal; }
    .audit-done-tree-meta {
      margin-left: auto; font-size: 11px; color: #aaa;
      flex-shrink: 0; white-space: nowrap; padding-left: 6px;
    }
    /* level-4: 조서 노드 — 클릭 시 Todo 목록 토글 */
    .audit-done-l4 { cursor: pointer; transition: background 0.12s; }
    .audit-done-l4:hover { background: #f0fdf4; }
    /* level-5: 완료된 Todo 아이템 */
    .audit-done-l5 {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 0; border-bottom: 1px solid #f5f5f3;
    }
    .audit-done-l5:last-child { border-bottom: none; }
    .audit-done-l5-check { color: #16a34a; font-size: 12px; flex-shrink: 0; }
    .audit-done-l5-text  { font-size: 12px; color: #555; line-height: 1.4; }

    /* ── 엑셀 바로가기 버튼 ─────────────────────────────────── */
    .audit-excel-open {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 4px;
      border: 1.5px solid #16a34a;
      background: #f0fdf4; color: #16a34a;
      font-size: 11px; font-family: inherit;
      cursor: pointer; flex-shrink: 0;
      transition: background 0.15s, color 0.15s;
      max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .audit-excel-open:hover { background: #16a34a; color: #fff; }
    .audit-excel-icon { font-size: 12px; flex-shrink: 0; }

    /* ── 일괄 완료 체크박스 ─────────────────────────────────── */
    .audit-complete-cb {
      width: 14px; height: 14px; flex-shrink: 0;
      cursor: pointer; accent-color: #22c55e;
      margin-left: 2px;
    }

    /* ── 완료 작업 우클릭 메뉴 ──────────────────────────────── */
    #audit-done-ctx {
      position: fixed; z-index: 10002; display: none;
      background: #fff;
      border: 1px solid #e0e0dc;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.13);
      padding: 4px; min-width: 168px;
    }
    .audit-ctx-item {
      padding: 8px 14px; font-size: 13px; color: #333;
      border-radius: 5px; cursor: pointer; transition: background 0.1s;
    }
    .audit-ctx-item:hover { background: #f0f0ee; }
    .audit-ctx-danger { color: #dc2626; }
    .audit-ctx-danger:hover { background: #fee2e2; }
    .audit-ctx-divider { height: 1px; background: #e8e8e4; margin: 3px 0; }
    #audit-pending-ctx {
      position: fixed; z-index: 10002; display: none;
      background: #fff;
      border: 1px solid #e0e0dc;
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.13);
      padding: 4px; min-width: 100px;
    }
  `;
  document.head.appendChild(s);

  // ── 세션 상세 모달 ──────────────────────────────────────────
  const sessionModal = document.createElement('div');
  sessionModal.id = 'audit-session-modal';
  sessionModal.innerHTML = `
    <div class="audit-modal-card">
      <div class="audit-modal-hdr">
        <span class="audit-modal-path" id="audit-modal-path"></span>
        <button class="audit-modal-close" id="audit-modal-close-btn">✕</button>
      </div>
      <div class="audit-modal-meta" id="audit-modal-meta"></div>
      <div class="audit-modal-todos" id="audit-modal-todos"></div>
      <div class="audit-modal-footer" id="audit-modal-footer"></div>
    </div>
  `;
  document.body.appendChild(sessionModal);
  document.getElementById('audit-modal-close-btn').addEventListener('click', closeAuditModal);
  sessionModal.addEventListener('click', (e) => { if (e.target === sessionModal) closeAuditModal(); });

  // ── 커스텀 입력 모달 ────────────────────────────────────────
  const inputModal = document.createElement('div');
  inputModal.id = 'audit-input-modal';
  inputModal.innerHTML = `
    <div class="audit-input-card">
      <div id="audit-input-label"></div>
      <div id="audit-input-chips" style="display:none"></div>
      <input type="text" id="audit-input-field" autocomplete="off">
      <div class="audit-input-footer">
        <button type="button" id="audit-input-cancel-btn">취소</button>
        <button type="button" id="audit-input-ok-btn">확인</button>
      </div>
    </div>
  `;
  document.body.appendChild(inputModal);
}

function _ensureDoneSection() {
  if (document.getElementById('audit-done-list')) return;
  const pendingList = document.getElementById('audit-pending-list');
  if (!pendingList) return;

  const section = document.createElement('div');
  section.className = 'audit-done-section';
  section.innerHTML = `
    <div class="audit-done-hdr">
      <h3>✓ 완료된 작업</h3>
    </div>
    <div id="audit-done-list" class="audit-done-list">
      <div class="audit-empty">완료된 작업이 없습니다</div>
    </div>
  `;
  pendingList.after(section);

  // 우클릭 컨텍스트 메뉴 DOM (최초 1회)
  if (!document.getElementById('audit-done-ctx')) {
    const menu = document.createElement('div');
    menu.id = 'audit-done-ctx';
    menu.innerHTML = `
      <div class="audit-ctx-item" id="audit-done-ctx-restore">↩ 보류 목록으로 되돌리기</div>
      <div class="audit-ctx-divider"></div>
      <div class="audit-ctx-item audit-ctx-danger" id="audit-done-ctx-delete">🗑 삭제</div>
    `;
    document.body.appendChild(menu);

    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) _hideDoneTreeCtx();
    });
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.audit-done-l4')) _hideDoneTreeCtx();
    });
  }

  // 보류 카드 우클릭 메뉴 DOM (최초 1회)
  if (!document.getElementById('audit-pending-ctx')) {
    const menu = document.createElement('div');
    menu.id = 'audit-pending-ctx';
    menu.innerHTML = `<div class="audit-ctx-item audit-ctx-danger" id="audit-pending-ctx-delete">🗑 삭제</div>`;
    document.body.appendChild(menu);

    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) _hidePendingCtx();
    });
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.audit-pending-card')) _hidePendingCtx();
    });
  }
}

// ── 완료 작업 우클릭 컨텍스트 메뉴 ──────────────────────────────────────────

let _doneCtxSessionId = null;

function _showDoneTreeCtx(e, sessionId) {
  _doneCtxSessionId = sessionId;
  const menu = document.getElementById('audit-done-ctx');
  if (!menu) return;
  document.getElementById('audit-done-ctx-restore').onclick = _auditRestoreDone;
  document.getElementById('audit-done-ctx-delete').onclick  = _auditDeleteDoneSession;
  menu.style.display = 'block';
  const mw = 180, mh = 80;
  const x = Math.min(e.clientX, window.innerWidth  - mw - 4);
  const y = Math.min(e.clientY, window.innerHeight - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

// ── 보류 카드 우클릭 컨텍스트 메뉴 ──────────────────────────────────────────

let _pendingCtxSessionId = null;

function _showPendingCtx(e, sessionId) {
  _pendingCtxSessionId = sessionId;
  const menu = document.getElementById('audit-pending-ctx');
  if (!menu) return;
  document.getElementById('audit-pending-ctx-delete').onclick = _auditDeletePendingSession;
  menu.style.display = 'block';
  const mw = 110, mh = 40;
  const x = Math.min(e.clientX, window.innerWidth  - mw - 4);
  const y = Math.min(e.clientY, window.innerHeight - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function _hidePendingCtx() {
  const menu = document.getElementById('audit-pending-ctx');
  if (menu) menu.style.display = 'none';
  _pendingCtxSessionId = null;
}

function _hideDoneTreeCtx() {
  const menu = document.getElementById('audit-done-ctx');
  if (menu) menu.style.display = 'none';
  _doneCtxSessionId = null;
}

async function _auditRestoreDone() {
  if (!_doneCtxSessionId) { _hideDoneTreeCtx(); return; }
  const sessionId = _doneCtxSessionId;
  _hideDoneTreeCtx();
  try {
    await window.electronAPI.audit.restoreToPending(sessionId);
    await Promise.all([renderAuditPending(), renderAuditDoneTree()]);
    const reqPanel = document.getElementById('audit-request-panel');
    if (reqPanel && reqPanel.style.display !== 'none') renderAuditRequestDashboard();
    if (_currentAuditView === 'kanban') renderAuditKanbanBoard();
  } catch (e) { console.error('[audit] _auditRestoreDone error', e); }
}

async function _auditDeleteDoneSession() {
  if (!_doneCtxSessionId) { _hideDoneTreeCtx(); return; }
  const sessionId = _doneCtxSessionId;
  _hideDoneTreeCtx();
  if (!confirm('이 완료 작업 기록을 삭제하시겠습니까?\n삭제 후 복구할 수 없습니다.')) return;
  try {
    await window.electronAPI.audit.deleteSession(sessionId);
    await renderAuditDoneTree();
    const reqPanel = document.getElementById('audit-request-panel');
    if (reqPanel && reqPanel.style.display !== 'none') renderAuditRequestDashboard();
    if (_currentAuditView === 'kanban') renderAuditKanbanBoard();
  } catch (e) { console.error('[audit] _auditDeleteDoneSession error', e); }
}

async function _auditDeletePendingSession() {
  if (!_pendingCtxSessionId) { _hidePendingCtx(); return; }
  const sessionId = _pendingCtxSessionId;
  _hidePendingCtx();
  if (!confirm('이 보류 작업을 삭제하시겠습니까?\n삭제 후 복구할 수 없습니다.')) return;
  try {
    await window.electronAPI.audit.deleteSession(sessionId);
    await renderAuditPending();
    if (_currentAuditView === 'kanban') renderAuditKanbanBoard();
  } catch (e) { console.error('[audit] _auditDeletePendingSession error', e); }
}

// ── 세션 상세 모달 ────────────────────────────────────────────────────────────

async function auditViewSession(sessionId, isDone = false) {
  const sess = await window.electronAPI.audit.getSession(sessionId);
  if (!sess) return;

  _modalSessionId = sessionId;

  const parts = [sess.company_name, sess.l2_name, sess.l3_name, sess.task_name].filter(Boolean);
  const pathStr = parts.length ? parts.join(' › ') : `세션 #${sessionId}`;

  const todos = sess.todos || [];
  const doneCount = todos.filter(t => t.done).length;

  document.getElementById('audit-modal-path').textContent = pathStr;
  document.getElementById('audit-modal-meta').textContent =
    `세션 #${sessionId} · 최종 활동: ${sess.last_active} · 할 일 ${todos.length}개 (${doneCount}개 완료)`;

  const todosEl = document.getElementById('audit-modal-todos');
  todosEl.innerHTML = '';
  if (!todos.length) {
    todosEl.innerHTML = '<div class="audit-modal-empty">체크리스트가 없습니다</div>';
  } else {
    for (const t of todos) {
      const row = document.createElement('div');
      row.className = 'audit-modal-todo-row';
      row.innerHTML = `
        <span class="audit-modal-todo-check">${t.done ? '☑' : '☐'}</span>
        <span class="audit-modal-todo-text ${t.done ? 'done' : ''}">${_esc(t.text)}</span>
      `;
      todosEl.appendChild(row);
    }
  }

  const footer = document.getElementById('audit-modal-footer');
  footer.innerHTML = '';
  if (!isDone) {
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'audit-btn-resume';
    resumeBtn.textContent = '▶ 이어서 작업하기';
    resumeBtn.onclick = () => _auditResumeSession(sessionId, false);
    footer.appendChild(resumeBtn);

    const completeBtn = document.createElement('button');
    completeBtn.className = 'audit-btn-complete';
    completeBtn.textContent = '✓ 완료 처리';
    completeBtn.onclick = () => _auditCompleteSession(sessionId);
    footer.appendChild(completeBtn);
  } else {
    const reopenBtn = document.createElement('button');
    reopenBtn.className = 'audit-btn-resume';
    reopenBtn.textContent = '↩ 재개하기';
    reopenBtn.onclick = () => _auditResumeSession(sessionId, true);
    footer.appendChild(reopenBtn);
  }

  document.getElementById('audit-session-modal').classList.add('open');
}

function closeAuditModal() {
  const modal = document.getElementById('audit-session-modal');
  if (modal) modal.classList.remove('open');
  _modalSessionId = null;
}

async function _auditResumeSession(sessionId, isDone = false) {
  if (_isMobile()) return;
  try {
    const result = await window.electronAPI.audit.resumeAndOpen(sessionId, isDone);
    if (!result.ok) {
      alert(result.error || '엑셀 파일을 열 수 없습니다.');
      return;
    }
    closeAuditModal();
    if (isDone) {
      // done → pending 전환됐으므로 두 목록 즉시 갱신
      await Promise.all([renderAuditPending(), renderAuditDoneTree()]);
    }
    // pending 세션은 즉시 갱신하지 않음
    // → 엑셀이 열리면 _auditScan이 감지 → audit:pending-updated → renderAuditPending() 자동 호출
  } catch (e) { console.error('[audit] _auditResumeSession error', e); }
}

async function _auditCompleteSession(sessionId) {
  if (_isMobile()) return;
  try {
    if (!confirm('이 작업을 완료 처리하시겠습니까?')) return;
    await window.electronAPI.audit.completeSession(sessionId);
    closeAuditModal();
    await Promise.all([renderAuditPending(), renderAuditDoneTree()]);
  } catch (e) { console.error('[audit] _auditCompleteSession error', e); }
}

// ── 트리 렌더링 ───────────────────────────────────────────────────────────────

async function renderAuditTree() {
  _nodeMap = null; // 검색 캐시 무효화 — CRUD 후 항상 초기화
  const el = document.getElementById('audit-tree');
  if (!el) return;
  const roots = await window.electronAPI.audit.getChildren(null);
  el.innerHTML = '';
  if (!roots.length) {
    el.innerHTML = '<div class="audit-empty">🏢 회사 추가 버튼으로 시작하세요</div>';
  } else {
    for (const node of roots) {
      el.appendChild(await _buildNodeEl(node, 0));
    }
  }
  // 현재 뷰에 맞게 갱신
  if (_currentAuditView === 'kanban') {
    renderAuditKanbanBoard();
  } else {
    const q = document.getElementById('audit-search')?.value.trim();
    if (q) _applyAuditSearch(q);
  }
}

async function _buildNodeEl(node, depth) {
  const children = await window.electronAPI.audit.getChildren(node.id);

  const wrap = document.createElement('div');
  wrap.className = 'audit-node-wrap';
  wrap.dataset.id = node.id;

  const row = document.createElement('div');
  row.className = `audit-row audit-level-${node.level}`;
  row.style.paddingLeft = `${depth * 16 + 8}px`;

  const toggle = children.length
    ? `<span class="audit-toggle" data-open="1">▾</span>`
    : `<span class="audit-toggle-gap"></span>`;

  const hasExcel = node.level === 4 && node.excel_path;
  const excelTag = hasExcel
    ? `<button class="audit-excel-open" title="${_esc(node.excel_path)}">
         <span class="audit-excel-icon">✦</span>${_esc(_basename(node.excel_path))}
       </button>`
    : '';

  const addBtn = node.level < 4
    ? `<button class="audit-btn" onclick="auditAddChild(${node.id},${node.level})">＋</button>`
    : '';
  const linkBtn = node.level === 4
    ? `<button class="audit-btn" onclick="auditLinkExcel(${node.id})" title="엑셀 연결">🔗</button>`
    : '';

  row.innerHTML = `
    ${toggle}
    <span class="audit-icon">${AUDIT_ICON[node.level] || '•'}</span>
    <span class="audit-name">${_esc(node.name)}</span>
    ${excelTag}
    <span class="audit-actions">
      ${addBtn}
      <button class="audit-btn" onclick="auditEditNode(${node.id})">✏</button>
      <button class="audit-btn audit-btn-del" onclick="auditDeleteNode(${node.id})">🗑</button>
      ${linkBtn}
      <input type="checkbox" class="audit-complete-cb"
             title="${_esc(node.name)} — 하위 항목 일괄 완료">
    </span>
  `;

  if (hasExcel) {
    row.querySelector('.audit-excel-open').addEventListener('click', (e) => {
      e.stopPropagation();
      auditOpenExcel(node.excel_path, node.id);
    });
  }

  // 일괄 완료 체크박스 — confirm 후 하위 세션 전체 완료 처리 (자동 토글 방지)
  row.querySelector('.audit-complete-cb').addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault(); // 체크박스 자동 체크 차단
    if (_isMobile()) return;
    const ok = confirm(
      `"${node.name}"의 하위 분류 및 세부 조서들을 모두 함께 완료 처리하시겠습니까?`
    );
    if (!ok) return; // 취소: 체크박스 미체크 상태 그대로 유지
    await window.electronAPI.audit.completeAllUnder(node.id);
    await Promise.all([renderAuditPending(), renderAuditDoneTree()]);
  });

  wrap.appendChild(row);

  if (children.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'audit-children';
    for (const c of children) childWrap.appendChild(await _buildNodeEl(c, depth + 1));
    wrap.appendChild(childWrap);

    row.querySelector('.audit-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = e.target.dataset.open === '1';
      childWrap.style.display = open ? 'none' : '';
      e.target.textContent   = open ? '▸' : '▾';
      e.target.dataset.open  = open ? '0' : '1';
    });
  }

  return wrap;
}

// ── 엑셀 파일 열기 ───────────────────────────────────────────────────────────

async function auditOpenExcel(filePath, nodeId) {
  const result = await window.electronAPI.audit.openExcel(filePath, nodeId);
  if (result.ok && result.newPath) {
    // 사용자가 새 경로로 재연결함 → 트리·칸반 UI 갱신
    renderAuditTree();
  } else if (!result.ok && !result.canceled) {
    alert(result.error || '파일을 열 수 없습니다.');
  }
}

// ── 트리 CRUD (prompt() → _showPrompt() 로 전면 교체) ────────────────────────

async function auditAddRoot() {
  if (_isMobile()) return;
  try {
    const name = await _showPrompt('회사명을 입력하세요');
    if (!name?.trim()) return;
    await window.electronAPI.audit.addNode(null, 1, name.trim(), null);
    renderAuditTree();
  } catch (e) { console.error('[audit] auditAddRoot error', e); }
}

async function auditAddChild(parentId, parentLevel) {
  if (_isMobile()) return;
  try {
    const level = parentLevel + 1;
    let name;
    if (level === 2) {
      name = await _pickL2();
      if (!name) return;
    } else {
      name = await _showPrompt(`${AUDIT_LABEL[level]} 입력`);
      if (!name?.trim()) return;
      name = name.trim();
    }
    await window.electronAPI.audit.addNode(parentId, level, name, null);
    renderAuditTree();
  } catch (e) { console.error('[audit] auditAddChild error', e); }
}

// L2 피커: 칩 버튼 선택 또는 직접 입력
async function _pickL2() {
  return _showPrompt('업무 대분류 선택', '', AUDIT_L2);
}

async function auditEditNode(id) {
  if (_isMobile()) return;
  try {
    const node = await window.electronAPI.audit.getNode(id);
    if (!node) return;
    const name = await _showPrompt('새 이름', node.name);
    if (!name?.trim() || name.trim() === node.name) return;
    await window.electronAPI.audit.updateNode(id, name.trim(), node.excel_path);
    renderAuditTree();
  } catch (e) { console.error('[audit] auditEditNode error', e); }
}

async function auditDeleteNode(id) {
  if (_isMobile()) return;
  try {
    const node = await window.electronAPI.audit.getNode(id);
    if (!node) return;
    if (!confirm(`'${node.name}' 및 모든 하위 항목을 삭제하시겠습니까?`)) return;
    await window.electronAPI.audit.deleteNode(id);
    renderAuditTree();
  } catch (e) { console.error('[audit] auditDeleteNode error', e); }
}

async function auditLinkExcel(id) {
  if (_isMobile()) return;
  try {
    const filePath = await window.electronAPI.audit.pickExcel();
    if (!filePath) return;
    const node = await window.electronAPI.audit.getNode(id);
    if (!node) return;
    await window.electronAPI.audit.updateNode(id, node.name, filePath);
    renderAuditTree();
  } catch (e) { console.error('[audit] auditLinkExcel error', e); }
}

// ── Pending 목록 ──────────────────────────────────────────────────────────────

let _pendingRenderVer = 0;

async function renderAuditPending() {
  const ver = ++_pendingRenderVer;
  const el = document.getElementById('audit-pending-list');
  if (!el) return;
  const rows = await window.electronAPI.audit.getPending();
  if (ver !== _pendingRenderVer) return; // 이후에 더 최신 렌더가 시작됐으면 폐기
  el.innerHTML = '';
  if (!rows.length) {
    el.innerHTML = '<div class="audit-empty">보류된 작업이 없습니다</div>';
    return;
  }
  for (const row of rows) {
    const parts = [row.company_name, row.l2_name, row.l3_name, row.task_name].filter(Boolean);
    const card = document.createElement('div');
    card.className = 'audit-pending-card';
    card.innerHTML = `
      <div class="audit-pending-path">${_esc(parts.join(' › '))}</div>
      <div class="audit-pending-meta">⏱ ${row.last_active}</div>
      <div class="audit-pending-meta">${_todoSummary(row.todos)}</div>
    `;
    card.addEventListener('click', () => auditViewSession(row.id, false));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _showPendingCtx(e, row.id);
    });
    el.appendChild(card);
  }
}

// ── 완료 작업 계층 트리 ──────────────────────────────────────────────────────

let _doneRenderVer = 0;

async function renderAuditDoneTree() {
  const ver = ++_doneRenderVer;
  _ensureDoneSection();
  const el = document.getElementById('audit-done-list');
  if (!el) return;

  const sessions = await window.electronAPI.audit.getDone();
  if (ver !== _doneRenderVer) return; // 이후에 더 최신 렌더가 시작됐으면 폐기
  el.innerHTML = '';

  if (!sessions.length) {
    el.innerHTML = '<div class="audit-empty">완료된 작업이 없습니다</div>';
    return;
  }

  // 계층형 그룹핑: company → l2 → l3 → node_id
  // 동일 node_id(조서)는 여러 세션이 있어도 Level-4 행 하나로 병합
  const tree = {};
  for (const sess of sessions) {
    const co  = sess.company_name || '(회사 없음)';
    const l2  = sess.l2_name      || '(대분류 없음)';
    const l3  = sess.l3_name      || '(중분류 없음)';
    const key = String(sess.node_id);

    tree[co]         ??= {};
    tree[co][l2]     ??= {};
    tree[co][l2][l3] ??= {};

    const todos     = typeof sess.todos === 'string'
      ? JSON.parse(sess.todos || '[]') : (sess.todos || []);
    const doneTodos = todos.filter(t => t.done).map(t => t.text);

    if (!tree[co][l2][l3][key]) {
      tree[co][l2][l3][key] = {
        sessionId:  sess.id,
        taskName:   sess.task_name || '세부조서',
        lastActive: sess.last_active || '',
        todoSet:    new Set(doneTodos),
      };
    } else {
      // 가장 최근 완료일 반영
      if ((sess.last_active || '') > tree[co][l2][l3][key].lastActive) {
        tree[co][l2][l3][key].lastActive = sess.last_active;
      }
      // 전체 세션의 완료된 Todo 병합 (텍스트 기준 중복 제거)
      for (const t of doneTodos) tree[co][l2][l3][key].todoSet.add(t);
    }
  }

  for (const [coName, l2Map] of Object.entries(tree)) {
    const coWrap = _makeDoneTreeWrap(coName, 1);
    const coChildren = coWrap.querySelector('.audit-children');

    for (const [l2Name, l3Map] of Object.entries(l2Map)) {
      const l2Wrap = _makeDoneTreeWrap(l2Name, 2);
      const l2Children = l2Wrap.querySelector('.audit-children');

      for (const [l3Name, nodeMap] of Object.entries(l3Map)) {
        const l3Wrap = _makeDoneTreeWrap(l3Name, 3);
        const l3Children = l3Wrap.querySelector('.audit-children');

        for (const nodeInfo of Object.values(nodeMap)) {
          l3Children.appendChild(_makeDoneL4Node(nodeInfo));
        }

        l2Children.appendChild(l3Wrap);
      }
      coChildren.appendChild(l2Wrap);
    }
    el.appendChild(coWrap);
  }
}

// 트리 폴더 노드 (level 1–3) — 토글 가능
function _makeDoneTreeWrap(name, level) {
  const wrap = document.createElement('div');
  wrap.className = 'audit-node-wrap';

  const row = document.createElement('div');
  row.className = `audit-row audit-level-${level}`;
  row.style.paddingLeft = `${(level - 1) * 16 + 8}px`;
  row.innerHTML = `
    <span class="audit-toggle" data-open="1">▾</span>
    <span class="audit-icon">${AUDIT_ICON[level] || '•'}</span>
    <span class="audit-name">${_esc(name)}</span>
  `;

  const children = document.createElement('div');
  children.className = 'audit-children';

  wrap.appendChild(row);
  wrap.appendChild(children);

  row.querySelector('.audit-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = e.target.dataset.open === '1';
    children.style.display = open ? 'none' : '';
    e.target.textContent   = open ? '▸' : '▾';
    e.target.dataset.open  = open ? '0' : '1';
  });

  return wrap;
}

// level-4 조서 노드 — 중복 없는 단일 행, 클릭 시 완료된 Todo 목록 토글
function _makeDoneL4Node({ sessionId, taskName, lastActive, todoSet }) {
  const wrap = document.createElement('div');
  wrap.className = 'audit-node-wrap';

  const dateStr = (lastActive || '').slice(0, 10);
  const todoArr = [...todoSet];

  const row = document.createElement('div');
  row.className = 'audit-row audit-level-4 audit-done-l4';
  row.style.paddingLeft = `${3 * 16 + 8}px`;
  row.innerHTML = `
    <span class="audit-toggle" data-open="0">▸</span>
    <span class="audit-icon audit-done-icon">✓</span>
    <span class="audit-name">${_esc(taskName)}</span>
    <span class="audit-done-tree-meta">${dateStr}${todoArr.length ? ' · ' + todoArr.length + '건' : ''}</span>
  `;

  const children = document.createElement('div');
  children.className = 'audit-children';
  children.style.display = 'none';

  for (const text of todoArr) {
    children.appendChild(_makeDoneL5Todo(text));
  }

  wrap.appendChild(row);
  wrap.appendChild(children);

  row.addEventListener('click', () => {
    const toggle = row.querySelector('.audit-toggle');
    const open = toggle.dataset.open === '1';
    children.style.display = open ? 'none' : '';
    toggle.textContent     = open ? '▸' : '▾';
    toggle.dataset.open    = open ? '0' : '1';
  });

  if (sessionId) {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _showDoneTreeCtx(e, sessionId);
    });
  }

  return wrap;
}

// level-5 완료된 Todo 아이템 — 들여쓰기 + ✓ 기호
function _makeDoneL5Todo(text) {
  const row = document.createElement('div');
  row.className = 'audit-row audit-done-l5';
  row.style.paddingLeft = `${4 * 16 + 8}px`;
  row.innerHTML = `
    <span class="audit-toggle-gap"></span>
    <span class="audit-done-l5-check">✓</span>
    <span class="audit-done-l5-text">${_esc(text)}</span>
  `;
  return row;
}

// ── 칸반보드 뷰 ──────────────────────────────────────────────────────────────

// 뷰 전환: 'tree' ↔ 'kanban'
function switchAuditView(view) {
  _currentAuditView = view;

  const treeView   = document.getElementById('audit-tree-view');
  const kanbanView = document.getElementById('audit-kanban-panel');
  const treeBtn    = document.getElementById('audit-vbtn-tree');
  const kanbanBtn  = document.getElementById('audit-vbtn-kanban');
  const sortSel    = document.getElementById('kanban-sort-select');

  if (view === 'tree') {
    if (treeView)   treeView.style.display   = '';
    if (kanbanView) kanbanView.style.display  = 'none';
    if (sortSel)    sortSel.style.display     = 'none';
    if (treeBtn)    treeBtn.classList.add('active');
    if (kanbanBtn)  kanbanBtn.classList.remove('active');
    const q = document.getElementById('audit-search')?.value.trim();
    if (q) _applyAuditSearch(q);
  } else {
    if (treeView)   treeView.style.display   = 'none';
    if (kanbanView) kanbanView.style.display  = '';
    if (sortSel)    sortSel.style.display     = '';
    if (treeBtn)    treeBtn.classList.remove('active');
    if (kanbanBtn)  kanbanBtn.classList.add('active');
    const treeEl   = document.getElementById('audit-tree');
    const resultEl = document.getElementById('audit-search-result');
    if (treeEl)   treeEl.style.display   = '';
    if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
    renderAuditKanbanBoard();
  }
}

// 칸반 컬럼 분류: done > review(!) > waiting(/) > writing
function _kanbanColumn(item) {
  if (!item.sessionStatus) return null;
  if (item.sessionStatus === 'done') return 'done';
  const undone = item.todos.filter(t => !t.done);
  if (undone.some(t => /^!\s/.test(t.text)))  return 'review';
  if (undone.some(t => /^\/\s/.test(t.text))) return 'waiting';
  return 'writing';
}

// 메인 렌더링 함수
async function renderAuditKanbanBoard() {
  const panel = document.getElementById('audit-kanban-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="audit-empty" style="padding:40px 0">불러오는 중…</div>';

  let items;
  try {
    items = await window.electronAPI.audit.getKanbanData();
  } catch (e) {
    panel.innerHTML = '<div class="audit-empty">데이터를 불러올 수 없습니다.</div>';
    return;
  }

  const cols = { waiting: [], writing: [], review: [], done: [] };
  for (const item of items) {
    const col = _kanbanColumn(item);
    if (col) cols[col].push(item);
  }

  const board = document.createElement('div');
  board.className = 'audit-kanban-board';

  const colDefs = [
    { key: 'waiting', label: '⏳ 자료 대기' },
    { key: 'writing', label: '📝 작성 중' },
    { key: 'review',  label: '🚨 리뷰노트 대응' },
    { key: 'done',    label: '✅ 마감 완료' },
  ];
  for (const { key, label } of colDefs) {
    board.appendChild(_makeKanbanCol(key, label, cols[key]));
  }

  panel.innerHTML = '';
  panel.appendChild(board);

  // 정렬 → 검색 순으로 적용 (정렬된 상태 위에 필터가 올라타도록)
  _sortKanbanColumns();
  const q = document.getElementById('audit-search')?.value.trim();
  if (q) _applyKanbanSearch(q);
}

function _makeKanbanCol(key, label, items) {
  const col = document.createElement('div');
  col.className = `audit-kanban-col col-${key}`;

  const hdr = document.createElement('div');
  hdr.className = 'audit-kanban-col-hdr';
  hdr.innerHTML =
    `<span>${label}</span><span class="audit-kanban-col-count">${items.length}</span>`;
  col.appendChild(hdr);

  const cards = document.createElement('div');
  cards.className = 'audit-kanban-cards';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'audit-kanban-empty';
    empty.textContent = '해당 항목 없음';
    cards.appendChild(empty);
  } else {
    for (const item of items) cards.appendChild(_makeKanbanCard(item));
  }

  // 검색 필터링 후 visible=0 일 때 표시할 "검색 결과 없음" 메시지 (기본 hidden)
  const noResult = document.createElement('div');
  noResult.className = 'audit-kanban-empty audit-kanban-noresult';
  noResult.style.display = 'none';
  noResult.textContent = '검색 결과 없음';
  cards.appendChild(noResult);

  col.appendChild(cards);
  return col;
}

function _makeKanbanCard(item) {
  const card = document.createElement('div');
  card.className = 'audit-kanban-card';
  card.dataset.searchText =
    `${item.companyName} ${item.l2Name} ${item.l3Name} ${item.nodeName}`.toLowerCase();
  card.dataset.lastActive = item.lastActive || '';

  const company = item.companyName || item.l2Name || '';
  const hasExcel = !!item.excelPath;

  card.innerHTML =
    `<div class="audit-kanban-company">${_esc(company)}</div>` +
    `<div class="audit-kanban-name">${_esc(item.nodeName)}</div>` +
    (hasExcel
      ? `<div class="audit-kanban-excel">✦ ${_esc(_basename(item.excelPath))}</div>`
      : `<div class="audit-kanban-no-excel">엑셀 미연결</div>`);

  if (hasExcel) {
    card.addEventListener('click', () => {
      window.electronAPI.audit.openExcel(item.excelPath, item.nodeId)
        .then(r => {
          if (r.ok && r.newPath) renderAuditKanbanBoard();
          else if (!r.ok && !r.canceled) alert(r.error || '파일을 열 수 없습니다.');
        });
    });
  }

  return card;
}

// 정렬 드롭다운 onchange 핸들러
function onKanbanSortChange(value) {
  _currentKanbanSort = value;
  _sortKanbanColumns();
  // 정렬 후 검색 필터 재적용 (hidden 상태 일관성 유지)
  const q = document.getElementById('audit-search')?.value.trim();
  if (q) _applyKanbanSearch(q);
}

// ✅ 마감 완료 컬럼을 제외한 3개 컬럼 카드를 lastActive 기준으로 DOM 재정렬
function _sortKanbanColumns() {
  const asc = _currentKanbanSort === 'asc';
  ['waiting', 'writing', 'review'].forEach(key => {
    const colEl = document.querySelector(`.audit-kanban-col.col-${key}`);
    if (!colEl) return;
    const container = colEl.querySelector('.audit-kanban-cards');
    if (!container) return;

    const cards = [...container.querySelectorAll('.audit-kanban-card')];
    if (cards.length < 2) return;

    cards.sort((a, b) => {
      const ta = a.dataset.lastActive || '';
      const tb = b.dataset.lastActive || '';
      // ISO datetime 문자열은 사전 순 비교가 시간 순과 동일
      return asc ? ta.localeCompare(tb) : tb.localeCompare(ta);
    });

    // '.audit-kanban-noresult' 바로 앞에 정렬된 카드들을 재삽입
    // → display:none 스타일은 카드에 귀속되므로 이동 후에도 유지됨
    const anchor = container.querySelector('.audit-kanban-noresult');
    cards.forEach(card => container.insertBefore(card, anchor));
  });
}

// 칸반 카드 인라인 필터 (검색어로 display:none 토글)
function _applyKanbanSearch(query) {
  const clearBtn = document.getElementById('audit-search-clear');
  if (clearBtn) clearBtn.style.display = query ? '' : 'none';

  const q = query.toLowerCase();

  document.querySelectorAll('.audit-kanban-col').forEach(colEl => {
    const allCards    = [...colEl.querySelectorAll('.audit-kanban-card')];
    const emptyEl     = colEl.querySelector('.audit-kanban-empty:not(.audit-kanban-noresult)');
    const noResultEl  = colEl.querySelector('.audit-kanban-noresult');
    const countEl     = colEl.querySelector('.audit-kanban-col-count');

    let visible = 0;
    for (const card of allCards) {
      const match = !q || (card.dataset.searchText || '').includes(q);
      card.style.display = match ? '' : 'none';
      if (match) visible++;
    }

    if (countEl) countEl.textContent = q ? `${visible}/${allCards.length}` : String(allCards.length);
    // 원래 "해당 항목 없음" 메시지는 검색 중에는 숨김
    if (emptyEl) emptyEl.style.display = (!q && allCards.length === 0) ? '' : 'none';
    // 카드가 있는 컬럼에서 모두 필터링됐을 때 "검색 결과 없음" 표시
    if (noResultEl) noResultEl.style.display = (q && allCards.length > 0 && visible === 0) ? '' : 'none';
  });
}

// ── 트리 검색 엔진 ───────────────────────────────────────────────────────────

// id → node 전체 맵 캐시 (renderAuditTree / CRUD 때 null 초기화)
let _nodeMap = null;
let _searchDebounce = null;

async function _ensureNodeMap() {
  if (_nodeMap) return _nodeMap;
  const all = await window.electronAPI.audit.getAllNodes();
  _nodeMap = {};
  for (const n of all) _nodeMap[n.id] = n;
  return _nodeMap;
}

// 루트에서 node.parent_id까지의 조상 배열 반환 (root→parent 순)
function _getAncestors(nodeId, nodeMap) {
  const ancestors = [];
  let cur = nodeMap[nodeId];
  while (cur?.parent_id != null) {
    const parent = nodeMap[cur.parent_id];
    if (!parent) break;
    ancestors.unshift(parent);
    cur = parent;
  }
  return ancestors;
}

// 검색어의 매칭 부분만 하이라이트 span으로 감싸기
function _highlight(text, query) {
  if (!query) return _esc(text);
  const lower = text.toLowerCase();
  const idx   = lower.indexOf(query.toLowerCase());
  if (idx === -1) return _esc(text);
  return (
    _esc(text.slice(0, idx)) +
    `<span class="audit-search-hl">${_esc(text.slice(idx, idx + query.length))}</span>` +
    _esc(text.slice(idx + query.length))
  );
}

// 경로 HTML 조합: [회사명] 매칭노드명 컴팩트 포맷 (중간 L2/L3 생략)
function _buildSearchPathHtml(ancestors, node, query) {
  // ancestors[0] = L1 회사 노드 (없으면 매칭 노드 자체가 최상위)
  const company = ancestors.length > 0 ? ancestors[0].name : null;
  const companyTag = company
    ? `<span class="audit-search-company">[${_esc(company)}]</span>`
    : '';
  return companyTag + `<span class="audit-search-match">${_highlight(node.name, query)}</span>`;
}

// index.html oninput → 디바운스 진입점 (뷰 상태에 따라 분기)
function onAuditSearch(rawQuery) {
  if (_searchDebounce) clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    const q = rawQuery.trim();
    if (_currentAuditView === 'kanban') _applyKanbanSearch(q);
    else _applyAuditSearch(q);
  }, 180);
}

// 검색창 × 버튼 — 즉시 초기화
function clearAuditSearch() {
  const inp = document.getElementById('audit-search');
  if (inp) inp.value = '';
  if (_currentAuditView === 'kanban') _applyKanbanSearch('');
  else _applyAuditSearch('');
}

async function _applyAuditSearch(query) {
  const treeEl   = document.getElementById('audit-tree');
  const resultEl = document.getElementById('audit-search-result');
  const clearBtn = document.getElementById('audit-search-clear');

  // ── 빈 쿼리: 원래 트리 복원 ──
  if (!query) {
    if (treeEl)   treeEl.style.display   = '';
    if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }

  // ── 검색 활성 ──
  if (clearBtn) clearBtn.style.display = '';
  if (treeEl)   treeEl.style.display   = 'none';
  if (resultEl) resultEl.style.display = '';
  resultEl.innerHTML = '<div class="audit-empty" style="padding:20px 0">검색 중…</div>';

  const nodeMap = await _ensureNodeMap();
  const q       = query.toLowerCase();
  const matches = Object.values(nodeMap).filter(n => n.name.toLowerCase().includes(q));

  resultEl.innerHTML = '';

  if (!matches.length) {
    resultEl.innerHTML =
      `<div class="audit-search-empty">「${_esc(query)}」에 해당하는 항목이 없습니다</div>`;
    return;
  }

  for (const node of matches) {
    const ancestors = _getAncestors(node.id, nodeMap);
    resultEl.appendChild(await _makeSearchResultRow(node, ancestors, query));
  }
}

// 검색 결과 행 — 전체 경로 표시 + 자식 토글 (lazy load)
async function _makeSearchResultRow(node, ancestors, query) {
  const children = await window.electronAPI.audit.getChildren(node.id);

  const wrap = document.createElement('div');
  wrap.className = 'audit-node-wrap';
  wrap.dataset.id = node.id;

  const row = document.createElement('div');
  // 레벨별 색상 유지, 들여쓰기는 제거 (flat list)
  row.className = `audit-row audit-level-${node.level}`;
  row.style.paddingLeft = '8px';

  const toggleHtml = children.length
    ? `<span class="audit-toggle" data-open="0">▸</span>`
    : `<span class="audit-toggle-gap"></span>`;

  const hasExcel = node.level === 4 && node.excel_path;
  const excelTag = hasExcel
    ? `<button class="audit-excel-open" title="${_esc(node.excel_path)}">
         <span class="audit-excel-icon">✦</span>${_esc(_basename(node.excel_path))}
       </button>`
    : '';

  const addBtn  = node.level < 4
    ? `<button class="audit-btn" onclick="auditAddChild(${node.id},${node.level})">＋</button>`
    : '';
  const linkBtn = node.level === 4
    ? `<button class="audit-btn" onclick="auditLinkExcel(${node.id})" title="엑셀 연결">🔗</button>`
    : '';

  row.innerHTML = `
    ${toggleHtml}
    <span class="audit-search-path">${_buildSearchPathHtml(ancestors, node, query)}</span>
    ${excelTag}
    <span class="audit-actions">
      ${addBtn}
      <button class="audit-btn" onclick="auditEditNode(${node.id})">✏</button>
      <button class="audit-btn audit-btn-del" onclick="auditDeleteNode(${node.id})">🗑</button>
      ${linkBtn}
      <input type="checkbox" class="audit-complete-cb"
             title="${_esc(node.name)} — 하위 항목 일괄 완료">
    </span>
  `;

  if (hasExcel) {
    row.querySelector('.audit-excel-open').addEventListener('click', (e) => {
      e.stopPropagation();
      auditOpenExcel(node.excel_path, node.id);
    });
  }

  // 일괄 완료 체크박스 — 기존 트리와 동일한 confirm 안전장치
  row.querySelector('.audit-complete-cb').addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (_isMobile()) return;
    const ok = confirm(
      `"${node.name}"의 하위 분류 및 세부 조서들을 모두 함께 완료 처리하시겠습니까?`
    );
    if (!ok) return;
    await window.electronAPI.audit.completeAllUnder(node.id);
    await Promise.all([renderAuditPending(), renderAuditDoneTree()]);
  });

  wrap.appendChild(row);

  if (children.length) {
    const childWrap = document.createElement('div');
    childWrap.className = 'audit-children';
    childWrap.style.display = 'none';
    let childrenLoaded = false;

    row.querySelector('.audit-toggle').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn  = e.target;
      const open = btn.dataset.open === '1';

      // 첫 펼침: children을 표준 _buildNodeEl로 lazy 빌드 (depth=1 → 16px 들여쓰기)
      if (!childrenLoaded && !open) {
        for (const c of children) {
          childWrap.appendChild(await _buildNodeEl(c, 1));
        }
        childrenLoaded = true;
      }

      childWrap.style.display = open ? 'none' : '';
      btn.textContent          = open ? '▸' : '▾';
      btn.dataset.open         = open ? '0' : '1';
    });

    wrap.appendChild(childWrap);
  }

  return wrap;
}

// ── 서브 탭 전환 ─────────────────────────────────────────────────────────────

function switchAuditSubTab(tab) {
  const mainPanel = document.getElementById('audit-main-panel');
  const reqPanel  = document.getElementById('audit-request-panel');
  if (mainPanel) mainPanel.style.display = tab === 'main'     ? '' : 'none';
  if (reqPanel)  reqPanel.style.display  = tab === 'requests' ? '' : 'none';
  document.querySelectorAll('.audit-sub-tab').forEach((el, i) => {
    el.classList.toggle('active', ['main', 'requests'][i] === tab);
  });
  if (tab === 'requests') renderAuditRequestDashboard();
}

// ── 자료 징구 관리 대시보드 ──────────────────────────────────────────────────

let _reqStylesInjected = false;

function _ensureRequestStyles() {
  if (_reqStylesInjected) return;
  _reqStylesInjected = true;
  // 스타일은 index.html <style> 블록에 정의 — 추가 주입 불필요
}

async function renderAuditRequestDashboard() {
  _ensureRequestStyles();
  const panel = document.getElementById('audit-request-panel');
  if (!panel) return;

  panel.innerHTML = '<div class="audit-empty" style="padding:40px 0">불러오는 중…</div>';

  let items;
  try {
    items = await window.electronAPI.audit.getRequestItems();
  } catch (e) {
    panel.innerHTML = '<div class="audit-empty">데이터를 불러올 수 없습니다.</div>';
    return;
  }

  panel.innerHTML = '';

  // 새로고침 버튼
  const refreshBar = document.createElement('div');
  refreshBar.className = 'audit-req-refresh';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'audit-req-refresh-btn';
  refreshBtn.textContent = '↺ 새로고침';
  refreshBtn.addEventListener('click', () => renderAuditRequestDashboard());
  refreshBar.appendChild(refreshBtn);
  panel.appendChild(refreshBar);

  const layout = document.createElement('div');
  layout.className = 'audit-req-layout';

  // ── 컬럼 생성 ──
  const draftCol    = _makeReqColumn('draft',    '📝 자료요청 작성 중',       '클라이언트에게 보낼 자료요청서 준비 항목');
  const waitingCol  = _makeReqColumn('waiting',  '⏳ 클라이언트 자료 대기 중', '발송 완료 — 회신 대기 중인 항목');
  const receivedCol = _makeReqColumn('received', '✅ 자료 수령 완료',          '수령 확인된 항목');
  const draftList    = draftCol.querySelector('.audit-req-list');
  const waitingList  = waitingCol.querySelector('.audit-req-list');
  const receivedList = receivedCol.querySelector('.audit-req-list');
  const draftCountEl    = draftCol.querySelector('.audit-req-count');
  const waitingCountEl  = waitingCol.querySelector('.audit-req-count');
  const receivedCountEl = receivedCol.querySelector('.audit-req-count');

  let draftTotal = 0, waitingTotal = 0, receivedTotal = 0;

  for (const item of items) {
    const pathParts = [item.companyName, item.l3Name, item.taskName].filter(Boolean);

    if (item.requests.length) {
      draftTotal += item.requests.length;
      draftList.appendChild(_makeReqGroup(item, item.requests, 'draft', pathParts));
    }
    if (item.waiting.length) {
      waitingTotal += item.waiting.length;
      waitingList.appendChild(_makeReqGroup(item, item.waiting, 'waiting', pathParts));
    }
    if (item.received && item.received.length) {
      receivedTotal += item.received.length;
      receivedList.appendChild(_makeReqGroup(item, item.received, 'received', pathParts));
    }
  }

  if (!draftTotal)    draftList.innerHTML    = '<div class="audit-req-empty">작성 중인 자료요청이 없습니다</div>';
  if (!waitingTotal)  waitingList.innerHTML  = '<div class="audit-req-empty">대기 중인 항목이 없습니다</div>';
  if (!receivedTotal) receivedList.innerHTML = '<div class="audit-req-empty">수령 완료된 항목이 없습니다</div>';

  draftCountEl.textContent    = draftTotal    || '';
  waitingCountEl.textContent  = waitingTotal  || '';
  receivedCountEl.textContent = receivedTotal || '';

  layout.appendChild(draftCol);
  layout.appendChild(waitingCol);
  layout.appendChild(receivedCol);
  panel.appendChild(layout);
}

function _makeReqColumn(type, title, subtitle) {
  const col = document.createElement('div');
  col.className = `audit-req-col audit-req-col-${type}`;
  col.innerHTML = `
    <div class="audit-req-col-hdr-inner">
      <span class="audit-req-col-title">${title}</span>
      <span class="audit-req-count"></span>
    </div>
    <div class="audit-req-col-sub">${_esc(subtitle)}</div>
    <div class="audit-req-list"></div>
  `;
  return col;
}

function _makeReqGroup(item, todos, type, pathParts) {
  const group = document.createElement('div');
  group.className = 'audit-req-group';

  // ── 경로 헤더 ──
  const pathHdr = document.createElement('div');
  pathHdr.className = 'audit-req-path-hdr';

  const pathIcon = document.createElement('span');
  pathIcon.className = 'audit-req-path-icon';
  pathIcon.textContent = AUDIT_ICON[1];

  const pathText = document.createElement('span');
  pathText.className = 'audit-req-path-text';
  pathText.title = pathParts.join(' › ');
  pathText.textContent = pathParts.join(' › ');

  pathHdr.appendChild(pathIcon);
  pathHdr.appendChild(pathText);

  // 자료 대기·수령 컬럼에 [조서 바로가기] 버튼 표시 (Electron 전용)
  if (type === 'waiting' || type === 'received') {
    const excelBtn = document.createElement('button');
    excelBtn.className = 'audit-req-excel-btn' + (item.excelPath ? '' : ' disabled');
    excelBtn.textContent = '📊 조서 열기';
    excelBtn.title = item.excelPath
      ? `열기: ${item.excelPath}`
      : '연동된 엑셀 파일 없음 — 트리에서 엑셀을 연결해 주세요';
    if (item.excelPath) {
      excelBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.electronAPI.audit.openExcel(item.excelPath, item.nodeId)
          .then(r => { if (!r.ok && !r.canceled) alert(r.error || '파일을 열 수 없습니다.'); });
      });
    }
    pathHdr.appendChild(excelBtn);
  }

  group.appendChild(pathHdr);

  // ── 투두 행 ──
  for (const todo of todos) {
    const display = todo.text.replace(/^[?/✓]\s+/, '');

    const row = document.createElement('div');
    row.className = `audit-req-row audit-req-row-${type}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'audit-req-cb';
    if (_isMobile()) cb.disabled = true;

    const textEl = document.createElement('span');
    textEl.className = 'audit-req-row-text';
    textEl.textContent = display;

    row.appendChild(cb);
    row.appendChild(textEl);

    if (type === 'draft') {
      // 체크 → 자료 대기 중(/ )으로 이동
      cb.title = '체크하면 [자료 대기 중]으로 이동합니다';
      cb.addEventListener('change', async () => {
        if (!cb.checked) return;
        if (_isMobile()) { cb.checked = false; return; }
        cb.disabled = true;
        row.style.opacity = '0.45';
        const newText = todo.text.replace(/^\?\s+/, '/ ');
        const ok = await window.electronAPI.audit.updateTodoText(item.sessionId, todo.text, newText);
        if (ok) {
          await renderAuditRequestDashboard();
        } else {
          cb.checked = false; cb.disabled = false; row.style.opacity = '';
          alert('업데이트에 실패했습니다. 앱을 재시작하거나 해당 팝업창을 직접 수정해 주세요.');
        }
      });

    } else if (type === 'waiting') {
      // 체크 → 수령 완료(✓ )로 이동
      cb.title = '체크하면 [자료 수령 완료]로 이동합니다';
      cb.addEventListener('change', async () => {
        if (!cb.checked) return;
        if (_isMobile()) { cb.checked = false; return; }
        cb.disabled = true;
        row.style.opacity = '0.45';
        const newText = todo.text.replace(/^\/\s+/, '✓ ');
        const ok = await window.electronAPI.audit.updateTodoText(item.sessionId, todo.text, newText);
        if (ok) {
          await renderAuditRequestDashboard();
        } else {
          cb.checked = false; cb.disabled = false; row.style.opacity = '';
          alert('업데이트에 실패했습니다.');
        }
      });

      // ✏️ 텍스트 수정 버튼 (엑셀 없이 직접 편집)
      const editBtn = document.createElement('button');
      editBtn.className = 'audit-req-edit-btn';
      editBtn.title = '항목 텍스트 수정';
      editBtn.textContent = '✏️';
      editBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newDisplay = await _showPrompt('자료 항목 수정', display);
        if (newDisplay === null || newDisplay.trim() === '' || newDisplay.trim() === display) return;
        const newText = '/ ' + newDisplay.trim();
        const ok = await window.electronAPI.audit.updateTodoText(item.sessionId, todo.text, newText);
        if (ok) {
          await renderAuditRequestDashboard();
        } else {
          alert('수정에 실패했습니다.');
        }
      });
      row.appendChild(editBtn);

      // ↩ 작성 중으로 되돌리기 버튼
      const revertBtn = document.createElement('button');
      revertBtn.className = 'audit-req-revert-btn';
      revertBtn.title = '자료요청 작성 중으로 되돌리기';
      revertBtn.textContent = '↩';
      revertBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        cb.disabled = true;
        row.style.opacity = '0.45';
        const newText = todo.text.replace(/^\/\s+/, '? ');
        const ok = await window.electronAPI.audit.updateTodoText(item.sessionId, todo.text, newText);
        if (ok) {
          await renderAuditRequestDashboard();
        } else {
          cb.disabled = false; row.style.opacity = '';
          alert('업데이트에 실패했습니다.');
        }
      });
      row.appendChild(revertBtn);

    } else if (type === 'received') {
      // 체크 해제 → 대기 중(/ )으로 되돌리기
      cb.checked = true;
      cb.title = '체크 해제하면 [자료 대기 중]으로 되돌립니다';
      cb.addEventListener('change', async () => {
        if (cb.checked) return;
        if (_isMobile()) { cb.checked = true; return; }
        cb.disabled = true;
        row.style.opacity = '0.45';
        const newText = todo.text.replace(/^✓\s+/, '/ ');
        const ok = await window.electronAPI.audit.updateTodoText(item.sessionId, todo.text, newText);
        if (ok) {
          await renderAuditRequestDashboard();
        } else {
          cb.checked = true; cb.disabled = false; row.style.opacity = '';
          alert('업데이트에 실패했습니다.');
        }
      });
    }

    group.appendChild(row);
  }

  return group;
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _basename(p) {
  return p ? p.replace(/.*[/\\]/, '') : '';
}

function _todoSummary(todosJson) {
  try {
    const t = typeof todosJson === 'string' ? JSON.parse(todosJson) : (todosJson || []);
    if (!t.length) return '할 일 없음';
    const done = t.filter(x => x.done).length;
    return `할 일 ${t.length}개 · ${done}개 완료`;
  } catch { return ''; }
}
