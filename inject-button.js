#!/usr/bin/env node
'use strict';
/**
 * inject-button.js
 * ─────────────────────────────────────────────────────────────────────
 * 실행: node inject-button.js
 *
 * index.html 의 탭 영역에서 '출결 관리' 탭 바로 다음 위치를 찾아
 * '시간표 등록' 탭 버튼을 안전하게 삽입합니다.
 *
 * - 이미 삽입된 경우 중복 삽입 없이 건너뜀 (멱등성 보장)
 * - 실행 전 index.html.bak 으로 자동 백업
 */

const fs   = require('fs');
const path = require('path');

const G = s => `\x1b[32m${s}\x1b[0m`;
const Y = s => `\x1b[33m${s}\x1b[0m`;
const R = s => `\x1b[31m${s}\x1b[0m`;
const B = s => `\x1b[1m${s}\x1b[0m`;
const C = s => `\x1b[36m${s}\x1b[0m`;

const INDEX_PATH = path.join(__dirname, 'index.html');
const BAK_PATH   = INDEX_PATH + '.bak';

// ── 삽입할 버튼 (기존 .tab 클래스와 동일한 패턴) ────────────────────
const NEW_TAB =
  `  <div class="tab" onclick="location.href='schedule.html'">` +
  `<i class="ti ti-calendar-plus"></i> <span>시간표 등록</span></div>`;

// ── 삽입 기준점: 출결 관리 탭이 있는 줄을 탐색 ──────────────────────
//  실제 파일의 해당 줄:
//    <div class="tab" onclick="switchTab('attendance')">...<span>출결 관리</span></div>
const ANCHOR_PATTERN = /switchTab\('attendance'\)/;

// ── 중복 체크용: 이미 삽입되었다면 이 패턴이 존재함 ─────────────────
const ALREADY_PATTERN = /location\.href=['"]schedule\.html['"]/;

// ─────────────────────────────────────────────────────────────────────

console.log('\n' + B(C('━━━  index.html 탭 버튼 자동 삽입  ━━━')) + '\n');

// 1. 파일 읽기
if (!fs.existsSync(INDEX_PATH)) {
  console.error(R('  ✗  index.html 을 찾을 수 없습니다: ' + INDEX_PATH));
  process.exit(1);
}
const original = fs.readFileSync(INDEX_PATH, 'utf8');
const lines    = original.split('\n');
console.log(G(`  ✓  index.html 읽기 완료 (${lines.length}줄)`));

// 2. 중복 삽입 방지
if (ALREADY_PATTERN.test(original)) {
  console.log(Y('  ⚠  이미 시간표 등록 버튼이 존재합니다. 삽입을 건너뜁니다.'));
  console.log(Y("     (schedule.html 링크가 index.html 안에서 발견됨)"));
  console.log('\n' + B('완료. 추가 작업 불필요.') + '\n');
  process.exit(0);
}

// 3. 삽입 위치(앵커 줄) 탐색
let anchorIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (ANCHOR_PATTERN.test(lines[i])) {
    anchorIdx = i;
    break;
  }
}

if (anchorIdx === -1) {
  console.error(R("  ✗  '출결 관리' 탭(switchTab('attendance'))을 찾지 못했습니다."));
  console.error(R('     index.html 구조가 예상과 다릅니다. 수동으로 확인해 주세요.'));
  process.exit(1);
}

console.log(G(`  ✓  삽입 기준점 발견: ${anchorIdx + 1}번째 줄`));
console.log(`       → ${lines[anchorIdx].trim()}`);

// 4. index.html.bak 백업
fs.copyFileSync(INDEX_PATH, BAK_PATH);
console.log(Y('  📋 백업 완료: index.html.bak'));

// 5. 기준점 다음 줄에 삽입
lines.splice(anchorIdx + 1, 0, NEW_TAB);

// 6. 파일 저장
fs.writeFileSync(INDEX_PATH, lines.join('\n'), 'utf8');
console.log(G('  ✓  index.html 저장 완료'));

// 7. 결과 미리보기
console.log('\n' + B('─── 삽입 결과 미리보기 ────────────────────────────────────'));
for (let i = Math.max(0, anchorIdx - 1); i <= anchorIdx + 3; i++) {
  const marker = (i === anchorIdx + 1) ? C(' ◀ 신규') : '      ';
  console.log(`  ${String(i + 1).padStart(4)} │${marker} ${lines[i]}`);
}
console.log(B('────────────────────────────────────────────────────────────'));

console.log('\n' + B(G('✅  완료!')) + `  탭 목록에 '시간표 등록' 버튼이 추가되었습니다.`);
console.log(C('\n  npm start') + ' 로 앱을 실행해 확인하세요.\n');
