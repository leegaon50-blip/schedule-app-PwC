// renderer/scheduleView.js  —  출결 관리 탭 전체 뷰 로직
'use strict';

// ── 모듈 상태 ─────────────────────────────────────────────────────────────────
let _draft      = [];   // 편집 중인 강의 배열
let _semesterId = null;
let _draftId    = null;

const _DAY_KO       = ['월','화','수','목','금','토','일'];
const _DAY_KO_INDEX = { '월': 0, '화': 1, '수': 2, '목': 3, '금': 4, '토': 5, '일': 6 };
const _PALETTE = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#3b82f6','#8b5cf6','#ec4899','#06b6d4',
];

// ── 초기화 ───────────────────────────────────────────────────────────────────
function initScheduleView() {
  const fileInput = document.getElementById('ocr-file-input');
  if (!fileInput) return;

  fileInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleImageUpload(f);
    e.target.value = '';
  });

  // 드래그 앤 드롭
  const zone = document.getElementById('ocr-upload-zone');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) handleImageUpload(f);
  });

  loadActiveSemester();
}

async function loadActiveSemester() {
  if (!window.electronAPI?.getActiveSemester) return;
  const res = await window.electronAPI.getActiveSemester();
  if (res?.ok && res.data) {
    _semesterId = res.data.id;
    document.getElementById('ocr-semester-name').textContent = res.data.name;
    document.getElementById('ocr-semester-bar').style.display = '';
  }
}

// ── OCR 파이프라인 ───────────────────────────────────────────────────────────
async function handleImageUpload(file) {
  _showOcrState('loading');
  try {
    const raw  = await parseEverytimeImage(file);  // ocr.js
    _draft = _normalizeOcrResult(raw);
    _renderOcrReview();
    _showOcrState('review');
  } catch (err) {
    _showOcrState('upload');
    console.error('[OCR]', err);
    if (err.name === 'AbortError') {
      alert('요청 시간(30초)이 초과되었습니다.\n네트워크 상태를 확인하고 다시 시도해 주세요.');
    } else if (err.message === 'ERR_RATE_LIMIT') {
      alert('API 사용 한도를 초과했습니다.\n잠시 후 다시 시도해 주세요. (무료 플랜 분당 제한)');
    } else {
      // 진단용: 실제 에러 메시지를 그대로 노출
      alert('실패 사유: ' + err.message);
    }
  }
}

/** "9:00" → "09:00", "13:30" → "13:30" — HH:MM 강제 포맷 */
function _padTime(t) {
  if (!t) return '09:00';
  const [h, m = '00'] = String(t).split(':');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Gemini API 응답 배열 → 강의 배열.
 * AI가 course_name 기준으로 이미 그룹화해서 반환하므로 필드명만 매핑한다.
 */
function _normalizeOcrResult(raw) {
  return raw.map((course, i) => ({
    className: (course.course_name ?? '').trim() || '(인식 실패)',
    professor: '',
    color:     _PALETTE[i % _PALETTE.length],
    schedules: (course.schedules ?? []).map(s => ({
      dayOfWeek: _DAY_KO_INDEX[s.day] ?? 0,
      startTime: _padTime(s.start_time),
      endTime:   _padTime(s.end_time),
      classroom: s.classroom?.trim() || '미지정',
    })),
  }));
}

// ── UI 상태 전환 ──────────────────────────────────────────────────────────────
function _showOcrState(state) {
  document.getElementById('ocr-upload-zone').style.display  = state === 'upload'  ? '' : 'none';
  document.getElementById('ocr-loading-zone').style.display = state === 'loading' ? '' : 'none';
  document.getElementById('ocr-review-zone').style.display  = state === 'review'  ? '' : 'none';
}

// ── 렌더링 ───────────────────────────────────────────────────────────────────
function _renderOcrReview() {
  const container = document.getElementById('ocr-lecture-list');
  if (_draft.length === 0) {
    container.innerHTML =
      '<div class="empty" style="margin-bottom:8px">인식된 강의가 없습니다.<br>아래 버튼으로 직접 추가해 주세요.</div>';
    return;
  }
  container.innerHTML = '';
  _draft.forEach((lec, idx) => container.appendChild(_buildLectureCard(lec, idx)));
}

function _buildLectureCard(lec, idx) {
  const card = document.createElement('div');
  card.className   = 'ocr-lecture-card';
  card.dataset.idx = idx;

  const schedRows = lec.schedules
    .map((s, si) => _scheduleRowHtml(idx, si, s, lec.schedules.length))
    .join('');

  card.innerHTML = `
    <div class="ocr-card-header">
      <div class="ocr-color-dot" style="background:${lec.color}" title="클릭하여 색상 변경"
           onclick="cycleColor(${idx})"></div>
      <input class="ocr-inp ocr-classname" type="text"
             placeholder="강의명 (필수)" value="${_esc(lec.className)}"
             oninput="_draft[${idx}].className=this.value">
      <input class="ocr-inp ocr-professor" type="text"
             placeholder="담당교수 (선택)" value="${_esc(lec.professor)}"
             oninput="_draft[${idx}].professor=this.value">
      <button class="ocr-del-btn" title="이 강의 삭제" onclick="removeLecture(${idx})">
        <i class="ti ti-trash" style="font-size:15px"></i>
      </button>
    </div>
    <div class="ocr-sched-list" id="sched-list-${idx}">${schedRows}</div>
    <button class="ocr-add-sched-btn" onclick="addScheduleRow(${idx})">
      <i class="ti ti-plus"></i> 시간대 추가
      <span style="color:#aaa;font-size:11px">&nbsp;(예: 목요일에도 수업이 있다면)</span>
    </button>
  `;
  return card;
}

function _scheduleRowHtml(lecIdx, si, s, total) {
  const opts = _DAY_KO.map((d, i) =>
    `<option value="${i}"${i === s.dayOfWeek ? ' selected' : ''}>${d}</option>`
  ).join('');

  return `
    <div class="ocr-sched-row" data-si="${si}">
      <select class="ocr-sel"
        onchange="_draft[${lecIdx}].schedules[${si}].dayOfWeek=parseInt(this.value)">
        ${opts}
      </select>
      <input class="ocr-inp ocr-time" type="time" value="${s.startTime}"
             onchange="_draft[${lecIdx}].schedules[${si}].startTime=this.value">
      <span class="ocr-time-sep">~</span>
      <input class="ocr-inp ocr-time" type="time" value="${s.endTime}"
             onchange="_draft[${lecIdx}].schedules[${si}].endTime=this.value">
      <input class="ocr-inp ocr-classroom" type="text" placeholder="강의실"
             value="${_esc(s.classroom)}"
             oninput="_draft[${lecIdx}].schedules[${si}].classroom=this.value">
      <button class="ocr-del-sched-btn" title="이 시간대 삭제"
              ${total > 1 ? '' : 'disabled'}
              onclick="removeScheduleRow(${lecIdx},${si})">
        <i class="ti ti-x"></i>
      </button>
    </div>
  `;
}

// ── 편집 액션 (전역 노출) ────────────────────────────────────────────────────
function addLecture() {
  _draft.push({
    className: '',
    professor: '',
    color: _PALETTE[_draft.length % _PALETTE.length],
    schedules: [{ dayOfWeek: 0, startTime: '09:00', endTime: '10:00', classroom: '' }],
  });
  _renderOcrReview();
  _showOcrState('review');
  const cards = document.querySelectorAll('.ocr-lecture-card');
  const last  = cards[cards.length - 1];
  last?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  last?.querySelector('.ocr-classname')?.focus();
}

function removeLecture(idx) {
  const name = _draft[idx]?.className?.trim() || '이 강의';
  if (!confirm(`"${name}"을(를) 목록에서 삭제하시겠습니까?`)) return;
  _draft.splice(idx, 1);
  _renderOcrReview();
}

function addScheduleRow(lecIdx) {
  const last   = _draft[lecIdx].schedules.at(-1);
  const nextDay = last ? Math.min(6, last.dayOfWeek + 2) : 0;
  _draft[lecIdx].schedules.push({
    dayOfWeek: nextDay,
    startTime: last?.startTime ?? '09:00',
    endTime:   last?.endTime   ?? '10:00',
    classroom: last?.classroom ?? '',
  });
  _reRenderSchedList(lecIdx);
}

function removeScheduleRow(lecIdx, si) {
  if (_draft[lecIdx].schedules.length <= 1) return;
  _draft[lecIdx].schedules.splice(si, 1);
  _reRenderSchedList(lecIdx);
}

function cycleColor(lecIdx) {
  const cur = _PALETTE.indexOf(_draft[lecIdx].color);
  _draft[lecIdx].color = _PALETTE[(cur + 1) % _PALETTE.length];
  const dot = document.querySelector(`.ocr-lecture-card[data-idx="${lecIdx}"] .ocr-color-dot`);
  if (dot) dot.style.background = _draft[lecIdx].color;
}

function resetOcrView() {
  _draft   = [];
  _draftId = null;
  _showOcrState('upload');
}

/** 스케줄 행만 선택적 재렌더링 (다른 입력 포커스 보존) */
function _reRenderSchedList(lecIdx) {
  const list  = document.getElementById(`sched-list-${lecIdx}`);
  if (!list) return;
  const total = _draft[lecIdx].schedules.length;
  list.innerHTML = _draft[lecIdx].schedules
    .map((s, si) => _scheduleRowHtml(lecIdx, si, s, total))
    .join('');
}

// ── 저장 ─────────────────────────────────────────────────────────────────────
async function confirmAndSave() {
  if (!_semesterId) {
    alert('활성 학기 정보가 없습니다.\n먼저 학기를 설정해 주세요.');
    return;
  }

  // 빈 강의명 검사
  const badIdx = _draft.findIndex(l => !l.className.trim());
  if (badIdx !== -1) {
    alert(`${badIdx + 1}번째 강의의 강의명을 입력해 주세요.`);
    document.querySelectorAll('.ocr-classname')[badIdx]?.focus();
    return;
  }
  // 시간 역전 검사
  for (let i = 0; i < _draft.length; i++) {
    for (const s of _draft[i].schedules) {
      if (s.startTime >= s.endTime) {
        alert(`"${_draft[i].className}" — 시작시간이 종료시간보다 늦거나 같습니다.\n(${s.startTime} ~ ${s.endTime})`);
        return;
      }
    }
  }
  if (_draft.length === 0) { alert('등록할 강의가 없습니다.'); return; }

  const btn = document.getElementById('ocr-confirm-btn');
  btn.disabled  = true;
  btn.innerHTML = '<i class="ti ti-loader" style="animation:ocr-spin .7s linear infinite;display:inline-block"></i>&nbsp; 저장 중...';

  try {
    // OCR 임시 초안 저장
    if (!_draftId && window.electronAPI?.saveOcrDraft) {
      const dr = await window.electronAPI.saveOcrDraft({
        semesterId: _semesterId,
        draftData:  _draft,
      });
      if (dr?.ok) _draftId = dr.draftId;
    }

    const invoker = window.electronAPI?.saveFinalSchedule ?? _webFakeSave;
    const res = await invoker({
      semesterId:     _semesterId,
      parsedLectures: _draft,
      draftId:        _draftId,
    });

    if (!res.ok) throw new Error(res.error ?? '알 수 없는 오류');
    _showSaveSuccess(res.data.saved.length, res.data.skipped ?? []);
  } catch (err) {
    alert('저장 실패: ' + err.message);
  } finally {
    btn.disabled  = false;
    btn.innerHTML = '<i class="ti ti-device-floppy"></i>&nbsp; 시간표 확정 및 저장';
  }
}

function _showSaveSuccess(savedCount, skipped) {
  const skipHtml = skipped.length > 0
    ? `<div style="color:#e67e22;font-size:12px;margin-top:6px">
         건너뛴 항목 ${skipped.length}개: ${skipped.map(_esc).join(' / ')}
       </div>`
    : '';

  document.getElementById('ocr-review-zone').innerHTML = `
    <div class="ocr-success">
      <i class="ti ti-circle-check"
         style="font-size:52px;color:#22c55e;display:block;margin-bottom:16px"></i>
      <div class="ocr-success-title">
        시간표 등록 및 이번 학기 출결 달력 생성이 완료되었습니다!
      </div>
      <div class="ocr-success-sub">
        ${savedCount}개 강의가 저장되었습니다.${skipHtml}
      </div>
      <button class="btn-sec"
              style="margin-top:24px;width:100%;max-width:280px"
              onclick="resetOcrView()">
        <i class="ti ti-arrow-left"></i> 처음으로 돌아가기
      </button>
    </div>
  `;
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function _webFakeSave(payload) {
  console.log('[web-mode] save-final-schedule →', JSON.stringify(payload, null, 2));
  return { ok: true, data: { saved: payload.parsedLectures, skipped: [] } };
}

// ── DOM 준비 후 실행 ──────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScheduleView);
} else {
  initScheduleView();
}
