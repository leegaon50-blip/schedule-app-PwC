// renderer/holidays.js  —  대한민국 공휴일/대체공휴일 유틸리티
'use strict';

/**
 * 음력 기반 공휴일 사전 정의 (설날·추석 연휴, 부처님오신날 + 대체공휴일)
 * 2028년 이후 음력 공휴일은 정부 확정 발표 후 갱신 필요.
 */
const _LUNAR_HOLIDAYS = {
  2024: [
    '02-09','02-10','02-11','02-12', // 설날 연휴 + 대체 (설날다음날 일요일)
    '05-15',                          // 부처님오신날
    '09-16','09-17','09-18',          // 추석 연휴
  ],
  2025: [
    '01-28','01-29','01-30',          // 설날 연휴
    '05-06',                          // 부처님오신날 대체 (어린이날과 중복 → 다음날)
    '10-05','10-06','10-07','10-08',  // 추석 연휴 + 대체 (연휴 중 일요일)
  ],
  2026: [
    '02-16','02-17','02-18',          // 설날 연휴
    '05-24','05-25',                  // 부처님오신날 + 대체 (일요일)
    '09-24','09-25','09-26','09-28',  // 추석 연휴 + 대체 (연휴 중 토요일)
  ],
  2027: [
    '02-07','02-08','02-09','02-10',  // 설날 연휴 + 대체 (설날전날 일요일)
    '05-13',                          // 부처님오신날
    '09-14','09-15','09-16',          // 추석 연휴
  ],
};

/** 고정 태양력 공휴일 (월-일) */
const _SOLAR_BASE = [
  '01-01', // 신정
  '03-01', // 삼일절
  '05-05', // 어린이날
  '06-06', // 현충일
  '08-15', // 광복절
  '10-03', // 개천절
  '10-09', // 한글날
  '12-25', // 크리스마스
];

/** 대체공휴일 적용 대상 (2023년 법 개정 기준) */
const _SUBST_ELIGIBLE = new Set(['01-01','03-01','05-05','06-06','08-15','10-03','10-09','12-25']);

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 해당 날짜가 공휴일(또는 대체공휴일)인지 반환한다.
 * @param {string} dateStr  'YYYY-MM-DD'
 * @returns {boolean}
 */
function isHoliday(dateStr) {
  const year = parseInt(dateStr.slice(0, 4), 10);
  return _getHolidaySet(year).has(dateStr);
}

// ── 내부 ──────────────────────────────────────────────────────────────────────

const _holidayCache = {};

function _getHolidaySet(year) {
  if (_holidayCache[year]) return _holidayCache[year];
  const set = new Set();

  // ① 고정 태양력 공휴일을 먼저 모두 추가
  for (const mmdd of _SOLAR_BASE) set.add(`${year}-${mmdd}`);

  // ② 음력 기반 공휴일 추가
  for (const mmdd of (_LUNAR_HOLIDAYS[year] ?? [])) set.add(`${year}-${mmdd}`);

  // ③ 대체공휴일 계산 — set이 완성된 후에 실행해야
  //    다른 공휴일과 겹치는 날을 정확히 건너뛸 수 있다
  for (const mmdd of _SOLAR_BASE) {
    if (!_SUBST_ELIGIBLE.has(mmdd)) continue;
    const dateStr = `${year}-${mmdd}`;
    const dow = new Date(dateStr).getDay(); // 0=일, 6=토
    if (dow === 0 || dow === 6) {
      set.add(_nextWeekdayNotHoliday(dateStr, set));
    }
  }

  _holidayCache[year] = set;
  return set;
}

/**
 * baseDate 다음 날부터 순회하며 주말·공휴일이 아닌 첫 평일을 반환한다.
 * (대체공휴일이 또 다른 공휴일과 겹치는 경우도 안전하게 처리)
 */
function _nextWeekdayNotHoliday(baseDate, holidaySet) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + 1);
  while (true) {
    const dow = d.getDay();
    const s   = _fmt(d);
    if (dow !== 0 && dow !== 6 && !holidaySet.has(s)) return s;
    d.setDate(d.getDate() + 1);
  }
}

function _fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
