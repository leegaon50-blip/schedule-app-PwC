'use strict';
// renderer/app.js — 일정 관리 앱 메인 로직 (index.html에서 분리)

// ── 환경 감지: Electron 여부 (감사업무 탭 진입 차단용) ────────────────────────────
window.isReadOnlyEnv = !(window.electronAPI && window.electronAPI.isElectron);

// ── GitHub 동기화 설정 ─────────────────────────────────────────────────────────
const SYNC = {
  token: (window.ENV && window.ENV.GITHUB_TOKEN) || '',
  owner: (window.ENV && window.ENV.REPO_OWNER) || '',
  repo:  (window.ENV && window.ENV.REPO_NAME) || '',
  file:  'tasks.json',
};
const _GH_API = `https://api.github.com/repos/${SYNC.owner}/${SYNC.repo}/contents/${SYNC.file}`;
let _ghSha    = localStorage.getItem('_gh_sha') || null;
let _ghSaving = false;

// ── 안전 유틸 ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `app-toast app-toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

function setSyncStatus(active) {
  const el = document.getElementById('sync-indicator');
  if (el) el.style.display = active ? 'flex' : 'none';
}

// ── GitHub 동기화 ──────────────────────────────────────────────────────────────

async function loadFromGitHub() {
  // Electron: 직접 GitHub API / Vercel 모바일: 서버리스 프록시
  if (!SYNC.token && window.electronAPI) return;
  setSyncStatus(true);
  try {
    let r;
    if (SYNC.token) {
      r = await fetch(_GH_API, {
        headers: { 'Authorization': 'token ' + SYNC.token, 'Accept': 'application/vnd.github.v3+json' },
      });
    } else {
      r = await fetch('/api/tasks');
    }
    if (r.status === 404) { await saveToGitHub(); return; }
    if (!r.ok) return;
    const data = await r.json();
    _ghSha = data.sha;
    localStorage.setItem('_gh_sha', _ghSha);
    const decoded = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
    if ((!decoded || decoded.length === 0) && tasks.length > 0) {
      await saveToGitHub();
      return;
    }
    if (decoded && decoded.length > 0) {
      tasks  = decoded;
      nextId = Math.max(0, ...getAllFlat().map(t => t.id)) + 1;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      renderCalendar();
      renderTaskList();
      if (document.getElementById('panel-progress').classList.contains('active')) renderProgress();
    }
  } catch(e) {
    console.warn('GitHub load failed:', e);
  } finally {
    setSyncStatus(false);
  }
}

async function saveToGitHub() {
  if (_ghSaving) return;
  // Electron에서 토큰 없으면 중단, 모바일(Vercel)은 토큰 없어도 프록시로 진행
  if (!SYNC.token && window.electronAPI) return;
  _ghSaving = true;
  try {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(tasks, null, 2))));
    const body = { message: 'sync ' + new Date().toISOString(), content };
    if (_ghSha) body.sha = _ghSha;
    let r;
    if (SYNC.token) {
      r = await fetch(_GH_API, {
        method:  'PUT',
        headers: {
          'Authorization': 'token ' + SYNC.token,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } else {
      r = await fetch('/api/tasks', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    if (r.status === 409) {
      _ghSha = null;
      localStorage.removeItem('_gh_sha');
      _ghSaving = false;
      await loadFromGitHub();
      await saveToGitHub();
      return;
    }
    if (r.ok) {
      const d = await r.json();
      _ghSha = d.content.sha;
      localStorage.setItem('_gh_sha', _ghSha);
    }
  } catch(e) {
    console.warn('GitHub save failed:', e);
  }
  _ghSaving = false;
}

// ── 데이터 ────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'schedule_app_tasks';

function getAllFlat() {
  const all = [];
  function collect(arr) { arr.forEach(t => { all.push(t); collect(t.subs || []); }); }
  collect(tasks);
  return all;
}

function loadTasks() {
  try {
    const d = localStorage.getItem(STORAGE_KEY);
    return d ? JSON.parse(d) : getDefaultTasks();
  } catch(e) { return getDefaultTasks(); }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  saveToGitHub();
}

function getDefaultTasks() {
  return [
    { id:1, name:'A법인 매출채권 조서', date:'2026-06-10', urgency:'high', track:'yes', memo:'담당: 김팀장', progress:40,  subs:[], memoLog:{} },
    { id:2, name:'B법인 재고자산 조서', date:'2026-06-20', urgency:'mid',  track:'yes', memo:'재고실사 필요',  progress:15,  subs:[], memoLog:{} },
    { id:3, name:'C법인 자료 요청',     date:'2026-06-05', urgency:'high', track:'no',  memo:'세금계산서 목록', progress:0, subs:[], memoLog:{} },
    { id:4, name:'D법인 매입채무 조서', date:'2026-07-15', urgency:'low',  track:'yes', memo:'',               progress:70,  subs:[], memoLog:{} },
  ];
}

let tasks  = loadTasks();
let nextId = Math.max(0, ...getAllFlat().map(t => t.id)) + 1;

const _now = new Date();
let curYear    = _now.getFullYear();
let curMonth   = _now.getMonth();
let sortMode   = 'deadline-asc';
let selectedDate = null;

const urgencyOrder = { high:0, mid:1, low:2, none:3 };
const urgencyLabel = { high:'🔴 긴급', mid:'🟡 보통', low:'🟢 여유', none:'⬜ 없음' };
const urgencyClass = { high:'urgency-high', mid:'urgency-mid', low:'urgency-low', none:'urgency-none' };

// ── 유틸 ──────────────────────────────────────────────────────────────────────

// date 필드(YYYY-MM-DD)만 비교, time 필드는 무시. 로컬(KST) 기준 자정으로 계산해 UTC 오차 방지
function daysLeft(d) {
  if (!d || typeof d !== 'string') return 0;
  try {
    const [y, m, day] = d.split('-').map(Number);
    if (!y || !m || !day) return 0;
    const deadline = new Date(y, m - 1, day);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((deadline - today) / 86400000);
  } catch(e) { return 0; }
}

function dlText(d)  { const n = daysLeft(d); return n < 0 ? `${Math.abs(n)}일 지남` : n === 0 ? '당일' : `${n}일전`; }
function dlClass(d) { return daysLeft(d) <= 3 ? 'days-left urgent' : 'days-left'; }

function getAllSubsFlat(subs) {
  let a = [];
  (subs || []).forEach(s => { a.push(s); a = a.concat(getAllSubsFlat(s.subs)); });
  return a;
}

function formatTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}:${String(m).padStart(2, '0')}`;
}

function getFormTime() {
  const ap = document.getElementById('mf-ampm').value;
  if (!ap) return null;
  let h = parseInt(document.getElementById('mf-hour').value);
  const m = document.getElementById('mf-min').value;
  if (ap === 'pm' && h !== 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m}`;
}

function timeToSelects(t) {
  if (!t) return { ap: '', h: '9', m: '00' };
  const [hh, mm] = t.split(':').map(Number);
  return { ap: hh < 12 ? 'am' : 'pm', h: String(hh % 12 || 12), m: String(mm).padStart(2, '0') };
}

function toDateStr(y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function findSubById(id) {
  let f = null;
  function s(ss) { ss.forEach(x => { if (x.id === id) f = x; else s(x.subs || []); }); }
  tasks.forEach(t => s(t.subs || []));
  return f;
}

function findSubParentTopId(id) {
  let f = null;
  tasks.forEach(t => { if (getAllSubsFlat(t.subs).find(s => s.id === id)) f = t.id; });
  return f;
}

// ── 탭 ───────────────────────────────────────────────────────────────────────

function switchTab(t) {
  // data-tab 속성 기반으로 활성 탭을 결정 (DOM 순서에 의존하지 않아 탭 추가·제거에 안전)
  document.querySelectorAll('.tab[data-tab]').forEach(el =>
    el.classList.toggle('active', el.dataset.tab === t));
  document.querySelectorAll('.panel').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('panel-' + t);
  if (panel) panel.classList.add('active');
  if (t === 'tasks')    renderTaskList();
  if (t === 'progress') renderProgress();
  if (t === 'jobs')     clearJobsBadge();
  if (t === 'audit')    initAuditTab();
}

// ── 달력 ──────────────────────────────────────────────────────────────────────

function selectDay(dateStr) {
  if (selectedDate === dateStr) {
    selectedDate = null;
    document.getElementById('day-panel').style.display = 'none';
    renderCalendar();
    return;
  }
  selectedDate = dateStr;
  renderCalendar();
  renderDayPanel(dateStr);
}

function renderDayPanel(dateStr) {
  try {
    const panel = document.getElementById('day-panel');
    const allSubs = [];
    tasks.forEach(t => getAllSubsFlat(t.subs).forEach(s => allSubs.push({ ...s, _parentName: t.name })));
    const dayTasks = tasks.filter(t => t.date === dateStr);
    const daySubs  = allSubs.filter(s => s.date === dateStr);
    const d = new Date(dateStr);
    const label = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    let rows = '';
    if (!dayTasks.length && !daySubs.length) {
      rows = `<div style="font-size:13px;color:#bbb;padding:8px 0">이 날의 일정이 없습니다.</div>`;
    } else {
      dayTasks.forEach(t => {
        const sc = getAllSubsFlat(t.subs || []).length;
        rows += `<div class="day-task-row" onclick="openTaskModal(${t.id})" oncontextmenu="showCtxMenu(event,${t.id},'main')" data-lp-id="${t.id}" data-lp-type="main">
          <span class="badge ${urgencyClass[t.urgency]}" style="font-size:10px">${urgencyLabel[t.urgency]}</span>
          <span class="day-task-name">${escHtml(t.name)}</span>
          <span class="day-task-meta">
            ${t.track === 'yes' ? `<span>${t.progress}%</span>` : ''}
            ${sc ? `<span style="font-size:10px;padding:1px 6px;border-radius:6px;background:#ebebff;color:#5b5bd6">세부 ${sc}</span>` : ''}
            <span style="color:${daysLeft(t.date) <= 3 ? '#c0392b' : '#aaa'}">${dlText(t.date)}</span>
          </span>
        </div>`;
      });
      daySubs.forEach(s => {
        rows += `<div class="day-task-row" onclick="openSubModal(${s.id})" oncontextmenu="showCtxMenu(event,${s.id},'sub')" data-lp-id="${s.id}" data-lp-type="sub">
          <span class="badge ${urgencyClass[s.urgency]}" style="font-size:10px">${urgencyLabel[s.urgency]}</span>
          <span class="day-task-name" style="color:#888">
            <i class="ti ti-corner-down-right" style="font-size:11px"></i>
            ${escHtml(s.name)} <span style="font-size:11px;color:#bbb">· ${escHtml(s._parentName)}</span>
          </span>
          <span class="day-task-meta">
            ${s.track === 'yes' ? `<span>${s.progress}%</span>` : ''}
            <span style="color:${daysLeft(s.date) <= 3 ? '#c0392b' : '#aaa'}">${dlText(s.date)}</span>
          </span>
        </div>`;
      });
    }
    panel.style.display = 'block';
    panel.innerHTML = `<div class="day-panel">
      <div class="day-panel-header">
        <span class="day-panel-title"><i class="ti ti-calendar-event"></i> ${escHtml(label)}</span>
        <button class="btn-sec" style="font-size:13px;padding:7px 14px;width:auto;min-height:40px"
                onclick="openAddModal(null,'${dateStr}')"><i class="ti ti-plus"></i> 일정 추가</button>
      </div>
      <div class="day-panel-body">${rows}</div>
    </div>`;
  } catch(e) {
    console.error('renderDayPanel error:', e);
  }
}

function renderCalendar() {
  try {
    const yearSel = document.getElementById('cal-year');
    if (yearSel) {
      const realYear = new Date().getFullYear();
      if (!yearSel.options.length) {
        for (let y = realYear - 5; y <= realYear + 10; y++) {
          const o = document.createElement('option');
          o.value = y; o.textContent = y + '년';
          yearSel.appendChild(o);
        }
      }
      if (!yearSel.querySelector(`option[value="${curYear}"]`)) {
        const o = document.createElement('option');
        o.value = curYear; o.textContent = curYear + '년';
        const arr = [...yearSel.options].map(x => +x.value);
        const idx = arr.findIndex(y => y > curYear);
        idx === -1 ? yearSel.appendChild(o) : yearSel.insertBefore(o, yearSel.options[idx]);
      }
      yearSel.value = curYear;
    }
    document.getElementById('cal-month').value = curMonth;
    const grid = document.getElementById('cal-grid');
    grid.querySelectorAll('.cal-day').forEach(e => e.remove());
    const first = new Date(curYear, curMonth, 1).getDay();
    const dim   = new Date(curYear, curMonth + 1, 0).getDate();
    const dip   = new Date(curYear, curMonth, 0).getDate();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const allSubs = [];
    tasks.forEach(t => getAllSubsFlat(t.subs).forEach(s => allSubs.push({ ...s })));
    let gridCol = 0;

    const addCell = (d, cls, dateStr) => {
      const dow = gridCol % 7; gridCol++;
      const cell = document.createElement('div');
      let cc = 'cal-day' + (cls ? ' ' + cls : '');
      if (dateStr && dateStr === selectedDate) cc += ' selected';
      if (dateStr && dateStr === toDateStr(today.getFullYear(), today.getMonth(), today.getDate())) cc += ' today';
      if (dow === 0) cc += ' sunday'; else if (dow === 6) cc += ' saturday';
      if (dateStr && isHoliday(dateStr)) cc += ' holiday';
      cell.className = cc;
      cell.innerHTML = `<div class="day-num">${d}</div>`;
      if (dateStr) {
        cell.onclick = () => selectDay(dateStr);
        const dt = tasks.filter(t => t.date === dateStr);
        const ds = allSubs.filter(s => s.date === dateStr);
        let shown = 0;
        dt.forEach(t => {
          if (shown >= 2) return; shown++;
          const ev = document.createElement('div');
          ev.className  = 'cal-evt ' + urgencyClass[t.urgency];
          ev.textContent = t.name;
          ev.onclick = e => { e.stopPropagation(); openTaskModal(t.id); };
          cell.appendChild(ev);
        });
        ds.forEach(s => {
          if (shown >= 2) return; shown++;
          const ev = document.createElement('div');
          ev.className  = 'cal-evt is-sub ' + urgencyClass[s.urgency];
          ev.textContent = '↳ ' + s.name;
          ev.onclick = e => { e.stopPropagation(); openSubModal(s.id); };
          cell.appendChild(ev);
        });
        const more = dt.length + ds.length - shown;
        if (more > 0) {
          const m = document.createElement('div');
          m.style.cssText = 'font-size:9px;color:#bbb;padding:0 2px';
          m.textContent = `+${more}`;
          cell.appendChild(m);
        }
      }
      grid.appendChild(cell);
    };

    for (let i = 0; i < first; i++) addCell(dip - first + 1 + i, 'other-month', null);
    for (let d = 1; d <= dim; d++) addCell(d, '', toDateStr(curYear, curMonth, d));
    const rem = 7 - ((first + dim) % 7 || 7);
    for (let d = 1; d <= rem && rem < 7; d++) addCell(d, 'other-month', null);
    if (selectedDate) renderDayPanel(selectedDate);
  } catch(e) {
    console.error('renderCalendar error:', e);
  }
}

function changeMonth(dir) {
  curMonth += dir;
  if (curMonth < 0)  { curMonth = 11; curYear--; }
  if (curMonth > 11) { curMonth = 0;  curYear++; }
  selectedDate = null;
  document.getElementById('day-panel').style.display = 'none';
  renderCalendar();
}

// ── 일정 목록 ─────────────────────────────────────────────────────────────────

function setSort(mode) {
  sortMode = mode;
  document.querySelectorAll('.sort-btn').forEach(b =>
    b.classList.toggle('active', b.getAttribute('onclick').includes(`'${mode}'`)));
  renderTaskList();
}

function getSortedTasks() {
  const t = [...tasks];
  if      (sortMode === 'deadline-asc')  t.sort((a, b) => a.date.localeCompare(b.date));
  else if (sortMode === 'deadline-desc') t.sort((a, b) => b.date.localeCompare(a.date));
  else if (sortMode === 'urgency-asc')   t.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]);
  else if (sortMode === 'urgency-desc')  t.sort((a, b) => urgencyOrder[b.urgency] - urgencyOrder[a.urgency]);
  else if (sortMode === 'progress-asc')  t.sort((a, b) => a.progress - b.progress);
  else                                   t.sort((a, b) => b.progress - a.progress);
  return t;
}

function renderTaskList() {
  try {
    const list = document.getElementById('task-list');
    const sorted = getSortedTasks();
    if (!sorted.length) { list.innerHTML = '<div class="empty">등록된 일정이 없습니다.</div>'; return; }
    const now = new Date();
    const todayStr   = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());
    const nowTimeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    // 과거 판별: 날짜가 지났거나, 오늘이지만 time이 지정되어 있고 현재 시각 이전
    const isPastTask = t => {
      if (t.date < todayStr) return true;
      if (t.date > todayStr) return false;
      return !!t.time && t.time <= nowTimeStr;
    };
    const current = sorted.filter(t => !isPastTask(t));
    const past    = sorted.filter(t =>  isPastTask(t));
    const cardHtml = (t, isPast) => {
      const sc = getAllSubsFlat(t.subs || []).length;
      return `<div class="task-card${isPast ? ' past' : ''}" onclick="openTaskModal(${t.id})"
                   oncontextmenu="showCtxMenu(event,${t.id},'main')"
                   data-lp-id="${t.id}" data-lp-type="main">
        <div class="task-card-header">
          <div class="task-name">${escHtml(t.name)}</div>
          <span class="badge ${urgencyClass[t.urgency]}">${urgencyLabel[t.urgency]}</span>
          <span class="${dlClass(t.date)}"><i class="ti ti-clock"></i> ${dlText(t.date)}</span>
        </div>
        ${t.memo ? `<div style="font-size:12px;color:#888;margin-bottom:4px">${escHtml(t.memo)}</div>` : ''}
        ${sc ? `<div style="font-size:11px;color:#bbb;margin-bottom:4px"><i class="ti ti-corner-down-right"></i> 세부일정 ${sc}개</div>` : ''}
        ${t.track === 'yes'
          ? `<div class="progress-bar-wrap"><div class="progress-bar" style="width:${t.progress}%"></div></div>
             <div class="task-meta"><span>${t.progress}% 완료</span><span>${t.date}${t.time ? ` ${formatTime(t.time)}` : ''}</span></div>`
          : `<div class="task-meta"><span style="color:#bbb">진행률 미관리</span><span>${t.date}${t.time ? ` ${formatTime(t.time)}` : ''}</span></div>`}
      </div>`;
    };
    let html = current.map(t => cardHtml(t, false)).join('');
    if (past.length) html += `<div class="task-section-sep">지난 일정</div>` + past.map(t => cardHtml(t, true)).join('');
    list.innerHTML = html || '<div class="empty">등록된 일정이 없습니다.</div>';
  } catch(e) {
    console.error('renderTaskList error:', e);
    const list = document.getElementById('task-list');
    if (list) list.innerHTML = '<div class="empty">일정을 불러오는 중 오류가 발생했습니다.</div>';
  }
}

// ── 진행률 탭 ─────────────────────────────────────────────────────────────────

function renderProgress() {
  try {
    const list = document.getElementById('prog-list');
    const trackable = [];
    tasks.filter(t => t.track === 'yes').forEach(t => trackable.push({ ...t, _type: 'main', _parentName: '' }));
    tasks.forEach(t => getAllSubsFlat(t.subs).filter(s => s.track === 'yes').forEach(s =>
      trackable.push({ ...s, _type: 'sub', _parentName: t.name })));
    if (!trackable.length) { list.innerHTML = '<div class="empty">진행률을 관리하는 일정이 없습니다.</div>'; return; }
    list.innerHTML = trackable.map(t => progCardHTML(t)).join('');
  } catch(e) {
    console.error('renderProgress error:', e);
  }
}

function progCardHTML(t) {
  return `<div class="prog-card">
    <div class="prog-top">
      <div>
        ${t._parentName ? `<div style="font-size:11px;color:#bbb;margin-bottom:2px"><i class="ti ti-corner-down-right"></i> ${escHtml(t._parentName)}</div>` : ''}
        <div class="prog-name">${escHtml(t.name)}</div>
      </div>
      <div class="prog-pct" id="ppct-${t.id}">${t.progress}%</div>
    </div>
    <div style="font-size:12px;color:#888;margin-bottom:6px">기한: ${t.date} · ${urgencyLabel[t.urgency]}</div>
    <div class="progress-bar-wrap" style="margin-bottom:4px">
      <div class="progress-bar" id="ppbar-${t.id}" style="width:${t.progress}%"></div>
    </div>
    <input type="range" class="prog-slider" min="0" max="100" step="5" value="${t.progress}"
           id="pslider-${t.id}" oninput="liveProgress('${t.id}',this.value)"
           >
    <textarea class="prog-memo-input" id="pmemo-${t.id}" placeholder="진행 상황 메모 (선택 사항)"></textarea>
    <div style="display:flex;align-items:center;margin-top:8px">
      <button class="btn-primary" style="font-size:13px;padding:8px 16px;width:auto;min-height:44px"
              onclick="saveProg('${t.id}','${t._type || 'main'}')">저장</button>
      <span class="save-ok" id="saved-${t.id}" style="display:none">저장됨 ✓</span>
    </div>
  </div>`;
}

function liveProgress(id, val) {
  const pct = document.getElementById('ppct-' + id);
  const bar = document.getElementById('ppbar-' + id);
  if (pct) pct.textContent = Math.round(val) + '%';
  if (bar) bar.style.width = val + '%';
}

function saveProg(id, type) {
  const numId  = parseInt(id);
  const slider = document.getElementById('pslider-' + id);  // id 기반 선택으로 안정성 확보
  const memoEl = document.getElementById('pmemo-' + id);
  if (!slider) return;
  const memo = memoEl ? memoEl.value.trim() : '';
  const val  = parseInt(slider.value);
  const target = type === 'main' ? tasks.find(t => t.id === numId) : findSubById(numId);
  if (target) {
    target.progress = val;
    if (memo) {
      const now = new Date().toLocaleString('ko-KR');
      target.memoLog[now] = memo;
      if (memoEl) memoEl.value = '';
    }
  }
  saveTasks(); renderCalendar(); renderTaskList();
  const ok = document.getElementById('saved-' + id);
  if (ok) { ok.style.display = 'inline'; setTimeout(() => { ok.style.display = 'none'; }, 2000); }
}

// ── 모달 ──────────────────────────────────────────────────────────────────────

let _modalCloseTimer = null;

function showModal(title, body) {
  if (_modalCloseTimer) { clearTimeout(_modalCloseTimer); _modalCloseTimer = null; }
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = body;
  const bg = document.getElementById('modal-bg');
  bg.style.display = 'flex';
  requestAnimationFrame(() => bg.classList.add('open'));
}

function closeModal() {
  const bg = document.getElementById('modal-bg');
  bg.classList.remove('open');
  _modalCloseTimer = setTimeout(() => {
    bg.style.display = 'none';
    _modalCloseTimer = null;
  }, 250);
}

function handleModalBgClick(e) {
  if (e.target === document.getElementById('modal-bg')) closeModal();
}

function buildInfoTab(item, isMain) {
  const dl = daysLeft(item.date);
  const memoKeys = Object.keys(item.memoLog || {});
  const id = item.id;
  const editFn  = isMain
    ? `showFormModal('일정 수정',tasks.find(t=>t.id===${id}),null,null)`
    : `showFormModal('세부일정 수정',findSubById(${id}),null,null)`;
  const addSubFn = `closeModal();showFormModal('세부일정 추가',null,${id},null)`;
  let html = `<div class="info-grid">
    <div class="info-cell"><div class="lbl">기한</div>
      <div class="val">${item.date}${item.time ? `<br><span style="font-size:11px;color:#888">${formatTime(item.time)}</span>` : ''}</div></div>
    <div class="info-cell"><div class="lbl">잔여</div>
      <div class="val" style="color:${dl <= 3 ? '#c0392b' : 'inherit'}">${dlText(item.date)}</div></div>
    <div class="info-cell"><div class="lbl">긴급도</div>
      <div class="val">${urgencyLabel[item.urgency]}</div></div>
  </div>
  ${item.memo ? `<div class="memo-box">${escHtml(item.memo)}</div>` : ''}
  ${item.track === 'yes'
    ? `<div style="margin-bottom:12px">
         <div style="font-size:12px;color:#888;margin-bottom:4px">진행률: ${item.progress}%</div>
         <div class="progress-bar-wrap"><div class="progress-bar" style="width:${item.progress}%"></div></div>
       </div>`
    : ''}
  ${memoKeys.length
    ? `<div style="margin-bottom:12px"><div class="section-label">메모 이력</div>
       ${memoKeys.slice(-3).map(k =>
         `<div class="memo-log-item"><span style="color:#bbb">${escHtml(k)}</span><br>${escHtml(item.memoLog[k])}</div>`
       ).join('')}</div>`
    : ''}
  <div style="margin-bottom:12px">
    ${(item.filePaths || []).length
      ? `<div class="section-label">첨부 파일</div>
         ${(item.filePaths || []).map((p, i) =>
           `<div class="file-chip"${window.electronAPI ? ` onclick="openAttachedFile(${id},${i})"` : ''}
                 title="${escHtml(p)}"><i class="ti ti-paperclip"></i> ${escHtml(p.replace(/.*[\\/]/, ''))}</div>`
         ).join('')}`
      : ''}
    ${window.electronAPI
      ? `<button class="btn-sec" style="font-size:12px;padding:6px 12px;width:auto;min-height:40px;margin-top:4px"
                 onclick="attachFileToTask(${id},'${isMain ? 'main' : 'sub'}')">
           <i class="ti ti-upload"></i> 파일 첨부</button>`
      : ''}
  </div>
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:6px">
    <div class="section-label" style="margin:0">세부일정</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn-sec" style="font-size:12px;padding:6px 12px;width:auto;min-height:40px"
              onclick="closeModal();${editFn}"><i class="ti ti-edit"></i> 수정</button>
      <button class="btn-sec" style="font-size:12px;padding:6px 12px;width:auto;min-height:40px"
              onclick="${addSubFn}"><i class="ti ti-plus"></i> 세부일정 추가</button>
    </div>
  </div>`;
  html += renderSubList(item.subs || []);
  return html;
}

function buildProgTab(item, type) {
  if (item.track !== 'yes') {
    return `<div style="text-align:center;padding:24px;color:#bbb;font-size:13px">진행률 관리가 비활성화되어 있습니다.<br>
      <button class="btn-sec" style="margin-top:12px;font-size:13px;width:auto;min-height:44px"
              onclick="enableTrack(${item.id},'${type}')">진행률 관리 활성화</button></div>`;
  }
  return progCardHTML({ ...item, _type: type, _parentName: '' });
}

function enableTrack(id, type) {
  const target = type === 'main' ? tasks.find(t => t.id === id) : findSubById(id);
  if (target) { target.track = 'yes'; saveTasks(); }
  if (type === 'main') openTaskModal(id, 'progress');
  else openSubModal(id, 'progress');
}

function openTaskModal(id, activeTab) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const tab = activeTab || 'info';
  showModal(task.name, `
    <div class="modal-tabs">
      <div class="modal-tab ${tab === 'info'     ? 'active' : ''}" onclick="switchModalTab('info')"><i class="ti ti-info-circle"></i> 상세 정보</div>
      <div class="modal-tab ${tab === 'progress' ? 'active' : ''}" onclick="switchModalTab('progress')"><i class="ti ti-chart-line"></i> 진행률</div>
    </div>
    <div id="mpanel-info"     class="modal-panel ${tab === 'info'     ? 'active' : ''}">${buildInfoTab(task, true)}</div>
    <div id="mpanel-progress" class="modal-panel ${tab === 'progress' ? 'active' : ''}">${buildProgTab(task, 'main')}</div>
  `);
}

function openSubModal(id, activeTab) {
  const sub = findSubById(id);
  if (!sub) return;
  const tab = activeTab || 'info';
  showModal(sub.name, `
    <div class="modal-tabs">
      <div class="modal-tab ${tab === 'info'     ? 'active' : ''}" onclick="switchModalTab('info')"><i class="ti ti-info-circle"></i> 상세 정보</div>
      <div class="modal-tab ${tab === 'progress' ? 'active' : ''}" onclick="switchModalTab('progress')"><i class="ti ti-chart-line"></i> 진행률</div>
    </div>
    <div id="mpanel-info"     class="modal-panel ${tab === 'info'     ? 'active' : ''}">${buildInfoTab(sub, false)}</div>
    <div id="mpanel-progress" class="modal-panel ${tab === 'progress' ? 'active' : ''}">${buildProgTab(sub, 'sub')}</div>
  `);
}

function switchModalTab(tab) {
  document.querySelectorAll('.modal-tab').forEach(el =>
    el.classList.toggle('active', el.getAttribute('onclick').includes(`'${tab}'`)));
  document.querySelectorAll('.modal-panel').forEach(el =>
    el.classList.toggle('active', el.id === 'mpanel-' + tab));
}

function renderSubList(subs) {
  if (!subs.length) return `<div style="font-size:13px;color:#bbb;padding:10px 0">세부일정이 없습니다.</div>`;
  return subs.map(s => {
    const sc = getAllSubsFlat(s.subs || []).length;
    return `<div class="sub-card" onclick="closeModal();openSubModal(${s.id})">
      <div class="sub-card-header">
        <span class="sub-card-name">${escHtml(s.name)}</span>
        <span class="sub-tag ${urgencyClass[s.urgency]}">${urgencyLabel[s.urgency]}</span>
        <span style="font-size:11px;color:${daysLeft(s.date) <= 3 ? '#c0392b' : '#bbb'};margin-left:4px">${dlText(s.date)}</span>
      </div>
      ${sc ? `<div style="font-size:11px;color:#bbb;margin-top:4px"><i class="ti ti-corner-down-right"></i> 하위 세부일정 ${sc}개</div>` : ''}
      ${s.track === 'yes'
        ? `<div style="margin-top:6px"><div style="font-size:11px;color:#bbb">${s.progress}%</div>
           <div class="sub-pb-wrap"><div class="sub-pb" style="width:${s.progress}%"></div></div></div>`
        : ''}
    </div>`;
  }).join('');
}

// ── 일정 추가/수정 ────────────────────────────────────────────────────────────

function openAddModal(parentId, prefillDate, prefillName, deadlineNote) {
  showFormModal('새 일정 추가', null, parentId, prefillDate, prefillName, deadlineNote);
}

function showFormModal(title, editItem, parentId, prefillDate, prefillName, deadlineNote) {
  const isEdit      = !!editItem;
  const defaultDate = prefillDate || (editItem ? editItem.date : '');
  const defaultName = isEdit ? editItem.name : (prefillName || '');
  const noteHtml    = deadlineNote
    ? `<div style="margin-top:4px;font-size:11px;padding:5px 8px;background:#fef3cd;border-radius:6px;color:#7a5c00;display:flex;align-items:center;gap:5px">
         <i class="ti ti-info-circle" style="flex-shrink:0"></i>공고 원문: <strong>${escHtml(deadlineNote)}</strong></div>`
    : '';
  const _ts   = timeToSelects(isEdit ? editItem.time : null);
  const _hrs  = Array.from({ length: 12 }, (_, i) =>
    `<option value="${i+1}" ${String(i+1) === _ts.h ? 'selected' : ''}>${i+1}시</option>`).join('');
  const _mins = ['00','10','20','30','40','50'].map(v =>
    `<option value="${v}" ${v === _ts.m ? 'selected' : ''}>${v}분</option>`).join('');
  showModal(title, `
    <div class="form-row">
      <div class="form-group"><label>이름 *</label>
        <input type="text" id="mf-name" value="${escHtml(defaultName)}" placeholder="일정 이름"></div>
      <div class="form-group"><label>기한 *</label>
        <input type="date" id="mf-date" value="${defaultDate}">${noteHtml}</div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>오전/오후</label>
        <select id="mf-ampm">
          <option value="" ${!_ts.ap ? 'selected' : ''}>시간 없음</option>
          <option value="am" ${_ts.ap === 'am' ? 'selected' : ''}>오전</option>
          <option value="pm" ${_ts.ap === 'pm' ? 'selected' : ''}>오후</option>
        </select>
      </div>
      <div class="form-group"><label>시간</label>
        <div style="display:flex;gap:6px">
          <select id="mf-hour" style="flex:1">${_hrs}</select>
          <select id="mf-min"  style="flex:1">${_mins}</select>
        </div>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>긴급도</label>
        <select id="mf-urgency">
          <option value="high" ${(isEdit ? editItem.urgency : 'mid') === 'high' ? 'selected' : ''}>🔴 긴급</option>
          <option value="mid"  ${(isEdit ? editItem.urgency : 'mid') === 'mid'  ? 'selected' : ''}>🟡 보통</option>
          <option value="low"  ${(isEdit ? editItem.urgency : 'mid') === 'low'  ? 'selected' : ''}>🟢 여유</option>
          <option value="none" ${(isEdit ? editItem.urgency : 'mid') === 'none' ? 'selected' : ''}>⬜ 없음</option>
        </select>
      </div>
      <div class="form-group"><label>진행률 관리</label>
        <select id="mf-track">
          <option value="yes" ${isEdit && editItem.track === 'yes' ? 'selected' : ''}>관리함</option>
          <option value="no"  ${!isEdit || editItem.track === 'no'  ? 'selected' : ''}>관리 안 함</option>
        </select>
      </div>
    </div>
    <div class="form-row full"><div class="form-group"><label>메모</label>
      <textarea id="mf-memo">${isEdit ? escHtml(editItem.memo || '') : ''}</textarea>
    </div></div>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn-primary" style="flex:1;min-height:48px"
              onclick="${isEdit ? `saveEdit(${editItem.id})` : `saveNew(${parentId === null ? 'null' : parentId})`}">
        ${isEdit ? '저장' : '추가하기'}</button>
      <button class="btn-sec" style="flex:1;min-height:48px" onclick="closeModal()">취소</button>
    </div>
  `);
}

function saveNew(parentId) {
  const name = document.getElementById('mf-name').value.trim();
  const date = document.getElementById('mf-date').value;
  if (!name || !date) { showToast('이름과 기한은 필수입니다.', 'warn'); return; }
  const item = {
    id: nextId++, name, date, time: getFormTime(),
    urgency:  document.getElementById('mf-urgency').value,
    track:    document.getElementById('mf-track').value,
    memo:     document.getElementById('mf-memo').value,
    progress: 0, subs: [], memoLog: {}, filePaths: [],
  };
  if (parentId === null) {
    tasks.push(item);
  } else {
    const p = tasks.find(t => t.id === parentId) || findSubById(parentId);
    if (p) p.subs.push(item);
  }
  saveTasks(); closeModal(); selectedDate = date; renderCalendar(); renderTaskList();
  if (parentId !== null) { const top = findSubParentTopId(parentId) || parentId; openTaskModal(top); }
}

function saveEdit(id) {
  const name = document.getElementById('mf-name').value.trim();
  const date = document.getElementById('mf-date').value;
  if (!name || !date) { showToast('이름과 기한은 필수입니다.', 'warn'); return; }
  const t = tasks.find(t => t.id === id) || findSubById(id);
  if (t) {
    t.name    = name;
    t.date    = date;
    t.time    = getFormTime();
    t.urgency = document.getElementById('mf-urgency').value;
    t.track   = document.getElementById('mf-track').value;
    t.memo    = document.getElementById('mf-memo').value;
  }
  saveTasks(); closeModal(); renderCalendar(); renderTaskList();
}

// ── 컨텍스트 메뉴 (우클릭 / 롱프레스 공통) ────────────────────────────────────

let ctxTargetId = null, ctxTargetType = null, ctxJobId = null;

function _posCtxMenu(x, y) {
  const m = document.getElementById('ctx-menu');
  m.style.display = 'block';
  m.style.left = x + 'px';
  m.style.top  = y + 'px';
  const r = m.getBoundingClientRect();
  if (r.right  > window.innerWidth)  m.style.left = (x - r.width)  + 'px';
  if (r.bottom > window.innerHeight) m.style.top  = (y - r.height) + 'px';
}

function showCtxMenu(e, id, type) {
  e.preventDefault(); e.stopPropagation();
  ctxTargetId = id; ctxTargetType = type; ctxJobId = null;
  document.getElementById('ctx-task-delete').style.display = 'flex';
  document.getElementById('ctx-job-deadline').style.display = 'none';
  _posCtxMenu(e.clientX, e.clientY);
}

function showJobCtxMenu(e, id) {
  e.preventDefault(); e.stopPropagation();
  ctxTargetId = null; ctxTargetType = null; ctxJobId = id;
  document.getElementById('ctx-task-delete').style.display = 'none';
  document.getElementById('ctx-job-deadline').style.display = 'flex';
  _posCtxMenu(e.clientX, e.clientY);
}

function hideCtxMenu() {
  document.getElementById('ctx-menu').style.display = 'none';
  ctxTargetId = null; ctxTargetType = null; ctxJobId = null;
}

function ctxDelete() {
  if (ctxTargetId === null) return;
  const name = ctxTargetType === 'main'
    ? (tasks.find(t => t.id === ctxTargetId) || {}).name
    : (findSubById(ctxTargetId) || {}).name;
  if (!confirm(`"${name}" 일정을 삭제하시겠습니까?`)) { hideCtxMenu(); return; }
  if (ctxTargetType === 'main') {
    tasks = tasks.filter(t => t.id !== ctxTargetId);
  } else {
    function removeSub(subs, id) {
      const idx = subs.findIndex(s => s.id === id);
      if (idx !== -1) { subs.splice(idx, 1); return; }
      subs.forEach(s => removeSub(s.subs || [], id));
    }
    tasks.forEach(t => removeSub(t.subs || [], ctxTargetId));
  }
  saveTasks(); hideCtxMenu();
  if (selectedDate) { const d = selectedDate; selectedDate = null; selectedDate = d; }
  renderCalendar(); renderTaskList();
  if (document.getElementById('panel-progress').classList.contains('active')) renderProgress();
}

document.addEventListener('click', hideCtxMenu);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { hideCtxMenu(); closeModal(); }
});

// ── 롱프레스 (touchstart → 700ms → 컨텍스트 메뉴) ────────────────────────────
// data-lp-id / data-lp-type : 일정 카드
// data-lp-job               : 채용공고 카드
let _lpTimer = null, _lpX = 0, _lpY = 0, _lpSkipClick = false;

document.addEventListener('touchstart', function(e) {
  const el = e.target.closest('[data-lp-id],[data-lp-job]');
  if (!el) return;
  const t = e.touches[0];
  _lpX = t.clientX; _lpY = t.clientY;
  el.classList.add('lp-active');
  const removeHighlight = () => el.classList.remove('lp-active');
  _lpTimer = setTimeout(function() {
    _lpTimer = null; _lpSkipClick = true;
    removeHighlight();
    if (navigator.vibrate) navigator.vibrate(50);
    const fakeE = { clientX: _lpX, clientY: _lpY, preventDefault() {}, stopPropagation() {} };
    if (el.dataset.lpId)  showCtxMenu(fakeE, parseInt(el.dataset.lpId), el.dataset.lpType);
    else if (el.dataset.lpJob) showJobCtxMenu(fakeE, el.dataset.lpJob);
  }, 700);
  el.addEventListener('touchend',    removeHighlight, { once: true, passive: true });
  el.addEventListener('touchcancel', removeHighlight, { once: true, passive: true });
}, { passive: true });

document.addEventListener('touchend',  function() { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } }, { passive: true });
document.addEventListener('touchmove', function() { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } }, { passive: true });

// 롱프레스 후 click 이벤트가 모달을 여는 것 방지 (캡처 단계에서 차단)
document.addEventListener('click', function(e) {
  if (_lpSkipClick) { _lpSkipClick = false; e.stopPropagation(); e.preventDefault(); }
}, true);

// ── 파일 첨부 ─────────────────────────────────────────────────────────────────

function openAttachedFile(taskId, idx) {
  const t = tasks.find(t => t.id === taskId) || findSubById(taskId);
  if (!t || !t.filePaths || !t.filePaths[idx]) return;
  window.electronAPI.openFile(t.filePaths[idx]);
}

async function attachFileToTask(taskId, type) {
  const result = await window.electronAPI.attachFile();
  if (!result) return;
  if (result.error) { showToast('파일 복사 실패:\n' + result.error, 'error'); return; }
  const target = type === 'main' ? tasks.find(t => t.id === taskId) : findSubById(taskId);
  if (!target) return;
  if (!target.filePaths) target.filePaths = [];
  target.filePaths.push(result);
  saveTasks();
  if (type === 'main') openTaskModal(taskId, 'info');
  else openSubModal(taskId, 'info');
}

// ── 채용공고 ──────────────────────────────────────────────────────────────────

let pendingNewJobIds = [], jobsMap = {};

function openJobUrl(id) {
  const job = jobsMap[id];
  if (!job) return;
  if (window.electronAPI) { window.electronAPI.openJob(job.bltnNo || String(id)); return; }
  const bltn = job.bltnNo || String(id);
  const f = document.createElement('form');
  f.method = 'POST';
  f.action = 'https://www.kicpa.or.kr/home/jobOffrSrchNewGnrl/detail.face';
  f.target = '_blank';
  const p = { ijIdNum:bltn,listCnt:'20',page:'1',srhType:'',srhKey:'',searchIjArea:'1800',searchArea:'18',
               ijCareer:'-1',ijLastschool:'-1',ijPay:'-1',ijEmpSep:'all',ijCoSep:'-1',
               searchAreaBack:'00',ijJobSep:'8',ijIntId:'',ijWname:'' };
  Object.entries(p).forEach(([k, v]) => {
    const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
  });
  document.body.appendChild(f); f.submit(); document.body.removeChild(f);
}

function showDeadlinePickerModal(job) {
  const today = new Date().toISOString().split('T')[0];
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:250;padding:16px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:20px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.18)">
      <div style="font-size:15px;font-weight:500;margin-bottom:14px">마감일 날짜 직접 지정</div>
      <div style="background:#fef9e7;border:1px solid #f0d9a0;border-radius:8px;padding:10px 12px;margin-bottom:14px">
        <div style="font-size:11px;color:#aaa;margin-bottom:3px">KICPA 마감일 원문</div>
        <div style="font-size:13px;font-weight:500;color:#1a1a1a">${escHtml(job.deadline_raw || '명시 없음')}</div>
      </div>
      <div style="font-size:12px;color:#666;margin-bottom:6px">달력에 추가할 날짜를 선택해 주세요</div>
      <input type="date" id="dp-input" value="${today}"
        style="width:100%;border:1px solid #e0e0dc;border-radius:8px;padding:10px 12px;font-size:16px;outline:none;margin-bottom:16px;-webkit-user-select:text;user-select:text">
      <div style="display:flex;gap:8px">
        <button id="dp-ok" style="flex:1;background:#1a1a1a;color:#fff;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:500;cursor:pointer">달력에 추가</button>
        <button id="dp-cancel" style="flex:1;background:none;border:1px solid #e0e0dc;border-radius:8px;padding:11px;font-size:14px;cursor:pointer">취소</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#dp-ok').onclick = () => {
    const d = overlay.querySelector('#dp-input').value;
    overlay.remove();
    openAddModal(null, d || null, job.title, job.deadline_raw);
  };
  overlay.querySelector('#dp-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function ctxAddJobDeadline() {
  const job = jobsMap[ctxJobId];
  hideCtxMenu();
  if (!job) return;
  if (!window.electronAPI) {
    if (job.deadline) { openAddModal(null, job.deadline, job.title); }
    else { showDeadlinePickerModal(job); }
    return;
  }
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;right:16px;background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:500;display:flex;align-items:center;gap:8px';
  toast.innerHTML = '<i class="ti ti-loader"></i> 전형 일정 조회 중...';
  document.body.appendChild(toast);
  try {
    const { stages, deadline, deadline_raw } = await window.electronAPI.getJobStages(job.bltnNo);
    toast.remove();
    if (stages && stages.length > 0) {
      showStagesConfirmModal(job, stages);
    } else {
      const note = (!deadline && deadline_raw) ? deadline_raw : null;
      openAddModal(null, deadline || null, job.title, note);
    }
  } catch(e) { toast.remove(); openAddModal(null, null, job.title); }
}

function showStagesConfirmModal(job, stages) {
  const company = job.company || job.title;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:250;padding:16px';
  overlay.innerHTML = `<div style="background:#fff;border-radius:14px;padding:20px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.18)">
    <div style="font-size:15px;font-weight:600;margin-bottom:4px">전형 일정 달력 추가</div>
    <div style="font-size:12px;color:#888;margin-bottom:14px">${escHtml(company)}</div>
    <div>${stages.map((s, i) =>
      `<label style="display:flex;align-items:center;gap:8px;padding:8px;background:#f5f5f3;border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px">
         <input type="checkbox" data-idx="${i}" checked style="width:16px;height:16px;flex-shrink:0">
         <span><strong>${escHtml(s.stage)}</strong>&nbsp;<span style="color:#888">${escHtml(s.date)}</span></span>
       </label>`).join('')}</div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button id="stages-ok" class="btn-primary" style="flex:1;min-height:44px;font-size:14px"><i class="ti ti-calendar-plus"></i> 추가하기</button>
      <button id="stages-cancel" class="btn-sec" style="width:80px;min-height:44px;font-size:14px">취소</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#stages-ok').onclick = () => {
    const checked = [...overlay.querySelectorAll('input[data-idx]:checked')].map(el => stages[+el.dataset.idx]);
    overlay.remove();
    addJobStageTasks(company, checked);
  };
  overlay.querySelector('#stages-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function addJobStageTasks(company, stages) {
  if (!stages.length) return;
  stages.forEach(({ stage, date }) => {
    tasks.push({
      id: nextId++, name: `[${company}] ${stage}`, date, time: null,
      urgency: stage.includes('서류') ? 'high' : 'mid',
      track: 'no', memo: '', progress: 0, subs: [], memoLog: {}, filePaths: [],
    });
  });
  saveTasks(); renderCalendar(); renderTaskList();
  showToast(`✓ ${stages.length}개 일정이 달력에 추가되었습니다`, 'success');
}

function clearJobsBadge() {
  pendingNewJobIds = [];
  const badge = document.getElementById('jobs-badge');
  if (badge) badge.style.display = 'none';
}

function openKicpa() {
  const LIST = 'https://www.kicpa.or.kr/home/jobOffrSrchNewGnrl/list.face';
  if (window.electronAPI) { window.electronAPI.openExternal(LIST); return; }
  const f = document.createElement('form');
  f.method = 'POST'; f.action = LIST; f.target = '_blank';
  const p = { listCnt:'50',page:'1',srhType:'',srhKey:'',searchIjArea:'1800',searchArea:'18',
               ijCareer:'-1',ijLastschool:'-1',ijPay:'-1',ijJobSep:'8' };
  Object.entries(p).forEach(([k, v]) => {
    const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
  });
  document.body.appendChild(f); f.submit(); document.body.removeChild(f);
}

function refreshJobs() {
  const btn = document.getElementById('jobs-refresh-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> 확인 중...'; }
  document.getElementById('jobs-list').innerHTML = '<div class="jobs-status"><i class="ti ti-loader"></i> 공고 불러오는 중...</div>';
  if (window.electronAPI) window.electronAPI.getJobs();
  else loadJobsFromJson();
}

async function loadJobsFromJson() {
  try {
    const res = await fetch('./kicpa_jobs.json?t=' + Date.now());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderJobs({ jobs: data.jobs || [], newIds: [], lastChecked: data.lastChecked || '', error: null });
  } catch(e) {
    const list = document.getElementById('jobs-list');
    if (list) list.innerHTML = '<div class="jobs-status"><i class="ti ti-alert-circle"></i> 공고를 불러오지 못했습니다.<br><span style="font-size:11px">잠시 후 다시 시도해 주세요.</span></div>';
    const btn = document.getElementById('jobs-refresh-btn');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> 새로고침'; }
  }
}

function renderJobs({ jobs, newIds, lastChecked, error }) {
  const checkEl = document.getElementById('jobs-last-check');
  if (checkEl && lastChecked) checkEl.textContent = `최근 확인: ${lastChecked}`;
  const btn = document.getElementById('jobs-refresh-btn');
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> 새로고침'; }
  const list = document.getElementById('jobs-list');
  if (!list) return;
  const jobsPanel   = document.getElementById('panel-jobs');
  const isJobsActive = jobsPanel && jobsPanel.classList.contains('active');
  if (newIds && newIds.length > 0 && !isJobsActive) {
    pendingNewJobIds = newIds;
    const badge = document.getElementById('jobs-badge');
    if (badge) { badge.textContent = newIds.length; badge.style.display = 'inline-flex'; }
  }
  if (error && (!jobs || !jobs.length)) {
    list.innerHTML = '<div class="jobs-status"><i class="ti ti-alert-circle"></i> 공고를 불러오지 못했습니다.<br><span style="font-size:11px">잠시 후 다시 시도해 주세요.</span></div>';
    return;
  }
  if (!jobs || !jobs.length) { list.innerHTML = '<div class="jobs-status">등록된 공고가 없습니다.</div>'; return; }
  const currentNewIds = new Set([...(newIds || []), ...pendingNewJobIds]);
  jobsMap = {};
  jobs.forEach(j => { jobsMap[j.id] = j; });
  list.innerHTML = jobs.map(j => `
    <div class="job-card" onclick="openJobUrl('${j.id}')"
         oncontextmenu="showJobCtxMenu(event,'${j.id}')" data-lp-job="${j.id}" title="길게 누르면 메뉴">
      <div class="job-card-top">
        <div class="job-title">${escHtml(j.title)}</div>
        ${currentNewIds.has(j.id) ? '<span class="new-badge">신규</span>' : ''}
      </div>
      <div class="job-meta">
        ${j.company ? `<span class="job-company">${escHtml(j.company)}</span>` : ''}
        <span><i class="ti ti-calendar" style="font-size:11px"></i> ${j.date}</span>
        ${j.deadline
          ? `<span style="color:#c0392b;font-weight:500"><i class="ti ti-clock" style="font-size:11px"></i> 마감 ${j.deadline}</span>`
          : j.deadline_raw
            ? `<span style="color:#888"><i class="ti ti-alert-circle" style="font-size:11px"></i> ${escHtml(j.deadline_raw)}</span>`
            : ''}
        <span>No. ${j.id}</span>
      </div>
    </div>`).join('');
}

if (window.electronAPI) {
  window.electronAPI.onJobsUpdated(renderJobs);
  window.electronAPI.onShowJobsTab(() => switchTab('jobs'));
}

// ── Electron 미니뷰 전환 ──────────────────────────────────────────────────────

let isMini = false;

function toggleWindowMode() {
  isMini = !isMini;
  const appWrap = document.querySelector('.app-wrap');
  const miniView = document.getElementById('mini-view');
  if (isMini) { renderMiniList(); appWrap.style.display = 'none'; miniView.classList.add('active'); }
  else        { appWrap.style.display = ''; miniView.classList.remove('active'); }
  if (window.electronAPI) window.electronAPI.setWindowMode(isMini ? 'mini' : 'large');
}

function renderMiniList() {
  const sorted   = [...tasks].sort((a, b) => a.date.localeCompare(b.date));
  const dotColor = { high:'#e74c3c', mid:'#f39c12', low:'#27ae60', none:'#bbb' };
  const list     = document.getElementById('mini-list');
  document.getElementById('mini-count').textContent = sorted.length + '개';
  if (!sorted.length) {
    list.innerHTML = '<div style="text-align:center;padding:30px;color:#bbb;font-size:12px">등록된 일정이 없습니다.</div>';
    return;
  }
  list.innerHTML = sorted.map(t => {
    const dl   = daysLeft(t.date);
    const mmdd = t.date.slice(5).replace('-', '/');
    return `<div class="mini-item">
      <div class="mini-dot" style="background:${dotColor[t.urgency] || '#bbb'}"></div>
      <div class="mini-item-name" title="${escHtml(t.name)}">${escHtml(t.name)}</div>
      <div class="mini-item-right">
        <div class="mini-item-date">${mmdd}</div>
        <div class="mini-item-dl${dl <= 3 ? ' urgent' : ''}">${dlText(t.date)}</div>
      </div>
    </div>`;
  }).join('');
}

// ── 달력 스와이프 (좌 = 다음달, 우 = 이전달) ──────────────────────────────────
(function() {
  let sx = 0, sy = 0, tracking = false;
  const outer = document.getElementById('cal-outer');
  const grid  = document.getElementById('cal-grid');

  outer.addEventListener('touchstart', e => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
    tracking = true;
    grid.style.transition = 'none';
  }, { passive: true });

  outer.addEventListener('touchmove', e => {
    if (!tracking) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    if (Math.abs(dx) > Math.abs(dy) * 1.2) grid.style.transform = `translateX(${dx}px)`;
  }, { passive: true });

  outer.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    const w  = grid.offsetWidth;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      const dir = dx < 0 ? 1 : -1;
      grid.style.transition = 'transform 0.25s ease-out';
      grid.style.transform  = `translateX(${dx < 0 ? -w : w}px)`;
      setTimeout(() => {
        grid.style.transition = 'none';
        grid.style.transform  = `translateX(${dx < 0 ? w : -w}px)`;
        changeMonth(dir);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          grid.style.transition = 'transform 0.25s ease-out';
          grid.style.transform  = 'translateX(0)';
        }));
      }, 250);
    } else {
      grid.style.transition = 'transform 0.2s ease-out';
      grid.style.transform  = 'translateX(0)';
    }
  }, { passive: true });
})();

// ── 자정(KST) 자동 새로고침 — 잔여일자 1일 차감 ──────────────────────────────
(function scheduleMidnightRefresh() {
  const now = new Date();
  const msToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000;
  setTimeout(function() {
    renderCalendar();
    renderTaskList();
    if (document.getElementById('panel-progress').classList.contains('active')) renderProgress();
    if (isMini) renderMiniList();
    scheduleMidnightRefresh();
  }, msToMidnight);
})();

// ── 시작 ──────────────────────────────────────────────────────────────────────
renderCalendar();
loadFromGitHub();
if (window.electronAPI) {
  window.electronAPI.getJobs();
} else {
  loadJobsFromJson();
  const mb = document.querySelector('.mini-btn');
  if (mb) mb.style.display = 'none';
}
