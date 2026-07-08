#!/usr/bin/env node
'use strict';
/**
 * setup-schedule-ui.js
 * ─────────────────────────────────────────────────────────────────────
 * 실행: node setup-schedule-ui.js
 *
 * 수행 작업
 *   1. schedule.html  생성 (드래그앤드롭 업로드 → OCR → 리뷰 → 저장)
 *   2. main.js        덮어쓰기 (OCR IPC 핸들러 3개 + 서비스 require 통합)
 *
 * 기존 파일은 .bak 으로 자동 백업합니다.
 */

const fs   = require('fs');
const path = require('path');

const ROOT   = __dirname;                 // 스크립트 위치 = 프로젝트 루트
const G = s  => `\x1b[32m${s}\x1b[0m`;  // 초록
const Y = s  => `\x1b[33m${s}\x1b[0m`;  // 노랑
const C = s  => `\x1b[36m${s}\x1b[0m`;  // 청록
const B = s  => `\x1b[1m${s}\x1b[0m`;   // 굵게

/* 파일 쓰기 + 자동 백업 */
function write(relPath, content) {
  const full = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });

  if (fs.existsSync(full)) {
    const bak = full + '.bak';
    fs.copyFileSync(full, bak);
    console.log(Y(`  📋 백업 → ${relPath}.bak`));
  }

  fs.writeFileSync(full, content, 'utf8');
  console.log(G(`  ✓  ${relPath}`));
}

console.log('\n' + B(C('━━━  schedule-app UI 자동 조립  ━━━')) + '\n');

/* ═══════════════════════════════════════════════════════════════════════
   FILE 1 : schedule.html
   ═══════════════════════════════════════════════════════════════════════ */
const SCHEDULE_HTML =
`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>시간표 등록 — 일정 관리</title>
  <link rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.x/dist/tabler-icons.min.css">
  <script src="https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js"></script>
  <style>
    /* ── Reset & Variables ──────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:      #f5f5f3;
      --surface: #ffffff;
      --border:  #e5e7eb;
      --text:    #1f2937;
      --sub:     #6b7280;
      --primary: #3b82f6;
      --pri-d:   #2563eb;
      --radius:  10px;
      --shadow:  0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.04);
    }

    html, body {
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', sans-serif;
      font-size: 14px;
      color: var(--text);
      background: var(--bg);
      overflow: hidden;
    }

    body { display: flex; flex-direction: column; }

    /* ── Electron 타이틀바 드래그 영역 ─────────────────────────────── */
    #drag-region {
      height: 28px;
      -webkit-app-region: drag;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }

    /* ── 상단 헤더 ──────────────────────────────────────────────────── */
    #app-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 20px;
      height: 50px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
      -webkit-app-region: no-drag;
    }

    #app-header h1 {
      flex: 1;
      text-align: center;
      font-size: 15px;
      font-weight: 600;
    }

    .btn-back {
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 5px 11px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--sub);
      font-size: 13px;
      cursor: pointer;
      transition: background .15s, color .15s;
    }
    .btn-back:hover { background: var(--bg); color: var(--text); }

    /* ── 학기 정보 바 ────────────────────────────────────────────────── */
    #ocr-semester-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 20px;
      background: #eff6ff;
      border-bottom: 1px solid #bfdbfe;
      font-size: 12px;
      color: #1e40af;
      flex-shrink: 0;
    }
    #ocr-semester-bar .sem-icon { font-size: 14px; }
    #ocr-semester-name { font-weight: 600; }

    /* ── 메인 스크롤 영역 ────────────────────────────────────────────── */
    #main-content {
      flex: 1;
      overflow-y: auto;
      padding: 28px 20px 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    #main-content::-webkit-scrollbar { width: 6px; }
    #main-content::-webkit-scrollbar-track { background: transparent; }
    #main-content::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }

    /* ── ① 업로드 존 ─────────────────────────────────────────────────── */
    #ocr-upload-zone {
      width: 100%;
      max-width: 540px;
      border: 2px dashed #d1d5db;
      border-radius: 14px;
      background: var(--surface);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 56px 28px;
      gap: 14px;
      cursor: default;
      transition: border-color .2s, background .2s;
      user-select: none;
    }
    #ocr-upload-zone.dragover {
      border-color: var(--primary);
      background: #eff6ff;
    }

    .upload-icon {
      font-size: 56px;
      color: #9ca3af;
      transition: color .2s;
    }
    #ocr-upload-zone.dragover .upload-icon { color: var(--primary); }

    #ocr-upload-zone > p {
      color: var(--sub);
      text-align: center;
      line-height: 1.8;
      font-size: 14px;
    }

    .upload-hint {
      font-size: 11px;
      color: #9ca3af;
      text-align: center;
    }

    .btn-upload {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 9px 22px;
      border-radius: 8px;
      border: none;
      background: var(--primary);
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
      transition: background .15s;
    }
    .btn-upload:hover { background: var(--pri-d); }

    /* ── ② 로딩 존 ──────────────────────────────────────────────────── */
    #ocr-loading-zone {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
      padding: 80px 24px;
      color: var(--sub);
    }

    .loading-spinner {
      font-size: 52px;
      color: var(--primary);
      animation: ocr-spin .8s linear infinite;
      display: block;
    }

    #ocr-loading-zone > p {
      font-size: 15px;
      color: var(--text);
      font-weight: 500;
    }

    @keyframes ocr-spin { to { transform: rotate(360deg); } }

    /* ── ③ 리뷰 존 ──────────────────────────────────────────────────── */
    #ocr-review-zone {
      width: 100%;
      max-width: 760px;
    }

    .review-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 18px;
      gap: 12px;
      flex-wrap: wrap;
    }
    .review-header h2 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
    .review-hint { font-size: 12px; color: var(--sub); line-height: 1.7; }
    .review-header-actions { display: flex; gap: 8px; flex-shrink: 0; }

    /* 보조 버튼 (scheduleView.js 성공 화면에서도 참조) */
    .btn-sec {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 7px 14px;
      border-radius: 7px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      font-size: 13px;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      transition: background .15s;
    }
    .btn-sec:hover { background: var(--bg); }

    /* 강의 목록 */
    #ocr-lecture-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 16px;
    }

    .empty {
      text-align: center;
      color: var(--sub);
      padding: 36px 16px;
      font-size: 14px;
      line-height: 1.9;
    }

    /* ── 강의 카드 ───────────────────────────────────────────────────── */
    .ocr-lecture-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: var(--shadow);
    }

    .ocr-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: #fafafa;
      flex-wrap: wrap;
    }

    .ocr-color-dot {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      cursor: pointer;
      flex-shrink: 0;
      box-shadow: 0 0 0 2px #fff, 0 0 0 3px #d1d5db;
      transition: transform .15s, box-shadow .15s;
    }
    .ocr-color-dot:hover {
      transform: scale(1.25);
      box-shadow: 0 0 0 2px #fff, 0 0 0 3px #9ca3af;
    }

    /* 입력 공통 */
    .ocr-inp {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 9px;
      font-size: 13px;
      color: var(--text);
      background: #fff;
      outline: none;
      font-family: inherit;
      transition: border-color .15s, box-shadow .15s;
    }
    .ocr-inp:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(59,130,246,.15);
    }

    .ocr-classname { flex: 2; min-width: 100px; font-weight: 500; }
    .ocr-professor { flex: 1.5; min-width: 80px; }

    .ocr-del-btn {
      margin-left: auto;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 3px;
      padding: 5px 9px;
      border-radius: 6px;
      border: 1px solid #fca5a5;
      background: #fff5f5;
      color: #dc2626;
      font-size: 12px;
      cursor: pointer;
      transition: background .15s;
    }
    .ocr-del-btn:hover { background: #fee2e2; }

    /* ── 시간대 행 ───────────────────────────────────────────────────── */
    .ocr-sched-list {
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .ocr-sched-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .ocr-sel {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 6px;
      font-size: 13px;
      background: #fff;
      color: var(--text);
      cursor: pointer;
      outline: none;
      min-width: 58px;
      font-family: inherit;
    }
    .ocr-sel:focus { border-color: var(--primary); }

    .ocr-time { width: 96px; }

    .ocr-time-sep {
      color: var(--sub);
      font-size: 13px;
      flex-shrink: 0;
    }

    .ocr-classroom { flex: 1; min-width: 80px; }

    .ocr-del-sched-btn {
      display: flex;
      align-items: center;
      padding: 4px 7px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #fff;
      color: #9ca3af;
      cursor: pointer;
      transition: background .15s, color .15s, border-color .15s;
    }
    .ocr-del-sched-btn:not([disabled]):hover {
      background: #fee2e2;
      border-color: #fca5a5;
      color: #dc2626;
    }
    .ocr-del-sched-btn[disabled] {
      opacity: .35;
      cursor: not-allowed;
    }

    .ocr-add-sched-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      width: 100%;
      padding: 8px 14px;
      border: none;
      border-top: 1px dashed #e5e7eb;
      background: #fafafa;
      color: var(--sub);
      font-size: 12px;
      cursor: pointer;
      font-family: inherit;
      transition: background .15s, color .15s;
    }
    .ocr-add-sched-btn:hover { background: #f0f9ff; color: var(--primary); }

    /* ── 확정 저장 바 ─────────────────────────────────────────────────── */
    .confirm-bar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 14px;
      padding: 16px 0 24px;
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
    }

    .confirm-hint {
      flex: 1;
      font-size: 12px;
      color: var(--sub);
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 200px;
    }

    #ocr-confirm-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 26px;
      border-radius: 8px;
      border: none;
      background: var(--primary);
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      transition: background .15s, opacity .15s;
    }
    #ocr-confirm-btn:hover:not([disabled]) { background: var(--pri-d); }
    #ocr-confirm-btn[disabled] { opacity: .6; cursor: not-allowed; }

    /* ── 성공 화면 (scheduleView.js _showSaveSuccess 에서 사용) ────────── */
    .ocr-success {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 60px 24px;
      text-align: center;
    }
    .ocr-success-title {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 10px;
    }
    .ocr-success-sub {
      font-size: 13px;
      color: var(--sub);
      line-height: 1.8;
    }
  </style>
</head>
<body>

  <!-- Electron 숨김 타이틀바용 드래그 영역 -->
  <div id="drag-region"></div>

  <!-- 상단 헤더 -->
  <header id="app-header">
    <button class="btn-back" onclick="window.location.href='index.html'">
      <i class="ti ti-chevron-left"></i> 돌아가기
    </button>
    <h1>에브리타임 시간표 등록</h1>
    <div style="width:80px"></div>
  </header>

  <!-- 활성 학기 정보 바 (loadActiveSemester() 에서 표시) -->
  <div id="ocr-semester-bar" style="display:none">
    <i class="ti ti-calendar-event sem-icon"></i>
    <span>등록 대상 학기 :</span>
    <strong id="ocr-semester-name"></strong>
    <span style="color:#93c5fd;margin-left:6px">— 이 학기 기준으로 출결 달력이 생성됩니다.</span>
  </div>

  <!-- 메인 콘텐츠 -->
  <main id="main-content">

    <!-- ① 업로드 존 -->
    <div id="ocr-upload-zone">
      <input id="ocr-file-input" type="file" accept="image/*" style="display:none">
      <i class="ti ti-photo-up upload-icon"></i>
      <p>
        에브리타임 시간표 스크린샷을<br>
        여기에 <strong>드래그</strong>하거나 아래 버튼으로 선택하세요.
      </p>
      <button class="btn-upload"
              onclick="document.getElementById('ocr-file-input').click()">
        <i class="ti ti-upload"></i>&nbsp; 파일 선택
      </button>
      <span class="upload-hint">
        JPG · PNG · WEBP 지원&nbsp;&nbsp;|&nbsp;&nbsp;Tesseract.js OCR (인터넷 연결 필요)
      </span>
    </div>

    <!-- ② 로딩 존 -->
    <div id="ocr-loading-zone" style="display:none">
      <i class="ti ti-loader-2 loading-spinner"></i>
      <p>이미지를 분석하는 중입니다…</p>
      <small style="color:#9ca3af">이미지 크기에 따라 10~30초 소요될 수 있습니다.</small>
    </div>

    <!-- ③ 리뷰 존 -->
    <div id="ocr-review-zone" style="display:none">

      <div class="review-header">
        <div>
          <h2>인식 결과 확인 및 수정</h2>
          <p class="review-hint">
            강의명·교수명·시간을 직접 수정하고, 색상 도트를 클릭해 달력 색상을 바꾸세요.
          </p>
        </div>
        <div class="review-header-actions">
          <button class="btn-sec" onclick="addLecture()">
            <i class="ti ti-plus"></i> 강의 추가
          </button>
          <button class="btn-sec" onclick="resetOcrView()">
            <i class="ti ti-refresh"></i> 다시 업로드
          </button>
        </div>
      </div>

      <!-- scheduleView.js 가 카드를 렌더링하는 컨테이너 -->
      <div id="ocr-lecture-list"></div>

      <div class="confirm-bar">
        <span class="confirm-hint">
          <i class="ti ti-info-circle"></i>
          저장 후에도 출결 관리 탭에서 언제든 수정할 수 있습니다.
        </span>
        <button id="ocr-confirm-btn" onclick="confirmAndSave()">
          <i class="ti ti-device-floppy"></i>&nbsp; 시간표 확정 및 저장
        </button>
      </div>

    </div><!-- /#ocr-review-zone -->

  </main>

  <script src="./renderer/ocr.js"></script>
  <script src="./renderer/scheduleView.js"></script>

</body>
</html>`;

/* ═══════════════════════════════════════════════════════════════════════
   FILE 2 : main.js  (OCR IPC 핸들러 통합 완성본)
   ═══════════════════════════════════════════════════════════════════════ */
const MAIN_JS =
`const { app, BrowserWindow, ipcMain, Notification, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { saveFinalSchedule, generateAttendanceRecords } = require('./services/scheduleService');
const { getDb } = require('./db/index');

// Anaconda Python 우선, 없으면 시스템 python 사용
const PYTHON_CANDIDATES = [
  'C:\\\\Users\\\\leega\\\\anaconda3\\\\python.exe',
  'C:\\\\Users\\\\leega\\\\anaconda3\\\\envs\\\\base\\\\python.exe',
  'python3',
  'python',
];

// Anaconda OpenSSL DLL 경로를 PATH에 추가 (SSL 오류 방지)
const ANACONDA_LIB = 'C:\\\\Users\\\\leega\\\\anaconda3\\\\Library\\\\bin';
const spawnEnv = { ...process.env, PATH: ANACONDA_LIB + ';' + (process.env.PATH || '') };

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

app.name = '일정 관리';
if (process.platform === 'win32') app.setAppUserModelId('일정 관리');

const JOBS_FILE = path.join(__dirname, 'kicpa_jobs.json');
const KICPA_NAV_URL = 'https://www.kicpa.or.kr/portal/default/kicpa/gnb/kr_pc/menu05/menu09.page';
const GDRIVE_FOLDER = process.env.SCHEDULE_GDRIVE_FOLDER || 'G:\\\\내 드라이브\\\\schedule_app_files';
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
        title: \`KICPA 새 구인공고 \${newIds.length}건\`,
        body: newJobs.slice(0, 3).map(j => j.title).join('\\n'),
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

    const tokenFile = path.join(__dirname, 'token.json');
    if (fs.existsSync(tokenFile)) {
      runPython(['notify'], JSON.stringify(newJobs)).catch(e => {
        console.error('[KakaoNotify]', e.message);
      });
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
    extraHeaders: 'Content-Type: application/x-www-form-urlencoded\\n',
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});`;

/* ═══════════════════════════════════════════════════════════════════════
   실행
   ═══════════════════════════════════════════════════════════════════════ */
write('schedule.html', SCHEDULE_HTML);
write('main.js',       MAIN_JS);

/* 이미 완료된 파일 존재 여부 확인 */
const extras = [
  'renderer/ocr.js',
  'renderer/scheduleView.js',
  'services/scheduleService.js',
  'services/attendanceService.js',
  'db/index.js',
  'preload.js',
];

console.log('');
console.log(C('  [확인] 사전 필요 파일'));
let allOk = true;
for (const f of extras) {
  const exists = fs.existsSync(path.join(ROOT, f));
  if (exists) {
    console.log(G(`  ✓  ${f}`));
  } else {
    console.log(`  \x1b[31m✗  ${f}  ← 없음!\x1b[0m`);
    allOk = false;
  }
}

console.log('');
if (allOk) {
  console.log(B(G('✅  모든 파일 정상. 앱을 시작하세요:')));
  console.log(C('\n     npm start\n'));
} else {
  console.log('\x1b[31m⚠   일부 파일이 없습니다. 위 파일들을 먼저 생성해 주세요.\x1b[0m\n');
}

console.log(B('─── index.html 버튼 추가 방법 ───────────────────────────────'));
console.log('  탭 버튼 목록이 있는 <nav> 또는 헤더 영역에 아래 코드를 삽입하세요:');
console.log('');
console.log(Y('  <button onclick="location.href=\'schedule.html\'">'));
console.log(Y('    <i class="ti ti-calendar-plus"></i> 시간표 등록'));
console.log(Y('  </button>'));
console.log('');
console.log('  (Tabler Icons 사용 중이라면 아이콘 클래스 ti-calendar-plus 적용됩니다)');
console.log(B('─────────────────────────────────────────────────────────────') + '\n');
