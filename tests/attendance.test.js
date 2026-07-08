// tests/attendance.test.js
// CI: better-sqlite3 Node ABI 재빌드 검증용 트리거 커밋
'use strict';

jest.mock('../db/index', () => {
  const Database       = require('better-sqlite3');
  const { SCHEMA_SQL } = jest.requireActual('../db/index');
  const db             = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return { getDb: () => db, SCHEMA_SQL };
});

const { updateAttendance, calcMaxAbsence, calcStatus } =
  require('../services/attendanceService');
const { saveFinalSchedule, generateAttendanceRecords } =
  require('../services/scheduleService');

let db;
beforeAll(() => { db = require('../db/index').getDb(); });

beforeEach(() => {
  db.exec(`
    DELETE FROM Attendance;
    DELETE FROM LectureSchedule;
    DELETE FROM Lecture;
    DELETE FROM Semester;
  `);
  try {
    db.exec(`
      DELETE FROM sqlite_sequence
       WHERE name IN ('Attendance','LectureSchedule','Lecture','Semester');
    `);
  } catch { /* sqlite_sequence may not exist yet */ }
});

function seedSemester({ name='2026-1학기', startDate='2026-03-02', endDate='2026-06-19' } = {}) {
  return db.prepare('INSERT INTO Semester (name, startDate, endDate) VALUES (?, ?, ?)')
    .run(name, startDate, endDate).lastInsertRowid;
}
function seedLecture(semId, { className='테스트강의', weeklyCount=1, maxOverride } = {}) {
  const max = maxOverride ?? calcMaxAbsence(weeklyCount);
  return db.prepare(`
    INSERT INTO Lecture (semesterId, className, weeklyCount, maxAbsenceAllowed)
    VALUES (?, ?, ?, ?)
  `).run(semId, className, weeklyCount, max).lastInsertRowid;
}
function seedSchedule(lecId, { dayOfWeek=1, startTime='10:00', endTime='12:00', classroom='IT관 201' } = {}) {
  return db.prepare(`
    INSERT INTO LectureSchedule (lectureId, dayOfWeek, startTime, endTime, classroom)
    VALUES (?, ?, ?, ?, ?)
  `).run(lecId, dayOfWeek, startTime, endTime, classroom).lastInsertRowid;
}
function seedAttendance(lecId, schId, date, absenceType='present') {
  return db.prepare(`
    INSERT INTO Attendance (lectureId, lectureScheduleId, date, absenceType)
    VALUES (?, ?, ?, ?)
  `).run(lecId, schId, date, absenceType).lastInsertRowid;
}

// ── 1. 순수 함수 ───────────────────────────────────────────────────────────────
describe('calcMaxAbsence', () => {
  test('주 1회 → 3회 허용', () => expect(calcMaxAbsence(1)).toBe(3));
  test('주 2회 → 6회 허용', () => expect(calcMaxAbsence(2)).toBe(6));
  test('주 3회 → 9회 허용', () => expect(calcMaxAbsence(3)).toBe(9));
  test('주 4회 → 12회 허용', () => expect(calcMaxAbsence(4)).toBe(12));
});
describe('calcStatus', () => {
  test('잔여 2회 이상 → safe',    () => expect(calcStatus(0, 3)).toBe('safe'));
  test('잔여 1회 → caution', () => expect(calcStatus(2, 3)).toBe('caution'));
  test('잔여 0회 → danger',  () => expect(calcStatus(3, 3)).toBe('danger'));
  test('초과 → fail',             () => expect(calcStatus(4, 3)).toBe('fail'));
  test('주 2회 safe',                 () => expect(calcStatus(3, 6)).toBe('safe'));
  test('주 2회 fail',                 () => expect(calcStatus(7, 6)).toBe('fail'));
});

// ── 2. updateAttendance ──────────────────────────────────────────────────────
describe('updateAttendance', () => {
  test('유효하지 않은 타입은 에러', () => {
    const s = seedSemester(), l = seedLecture(s), c = seedSchedule(l);
    const a = seedAttendance(l, c, '2026-03-03');
    expect(() => updateAttendance(a, 'BAD')).toThrow(/유효하지 않은/);
  });
  test('없는 id는 에러', () => {
    expect(() => updateAttendance(9999, 'normal')).toThrow(/없음/);
  });
  test('present → normal: absenceCount +1', () => {
    const s = seedSemester(), l = seedLecture(s, { weeklyCount: 1 });
    const c = seedSchedule(l), a = seedAttendance(l, c, '2026-03-03');
    const r = updateAttendance(a, 'normal');
    expect(r.absenceCount).toBe(1);
    expect(r.remaining).toBe(2);
    expect(r.status).toBe('safe');
  });
  test('normal → excused: absenceCount -1', () => {
    const s = seedSemester(), l = seedLecture(s);
    const c = seedSchedule(l), a = seedAttendance(l, c, '2026-03-03', 'normal');
    db.prepare("UPDATE Lecture SET absenceCount=1, status='safe' WHERE id=?").run(l);
    const r = updateAttendance(a, 'excused');
    expect(r.absenceCount).toBe(0);
    expect(r.status).toBe('safe');
  });
  test('주 1회: 2번 normal → caution', () => {
    const s = seedSemester(), l = seedLecture(s, { weeklyCount: 1 }), c = seedSchedule(l);
    const a1 = seedAttendance(l, c, '2026-03-03'), a2 = seedAttendance(l, c, '2026-03-10');
    updateAttendance(a1, 'normal');
    const r = updateAttendance(a2, 'normal');
    expect(r.status).toBe('caution');
    expect(r.remaining).toBe(1);
  });
  test('주 1회: 3번 normal → danger', () => {
    const s = seedSemester(), l = seedLecture(s, { weeklyCount: 1 }), c = seedSchedule(l);
    const ids = ['2026-03-03','2026-03-10','2026-03-17'].map(d => seedAttendance(l, c, d));
    ids.slice(0,2).forEach(id => updateAttendance(id, 'normal'));
    const r = updateAttendance(ids[2], 'normal');
    expect(r.status).toBe('danger');
    expect(r.remaining).toBe(0);
  });
  test('주 1회: 4번째 normal → fail', () => {
    const s = seedSemester(), l = seedLecture(s, { weeklyCount: 1 }), c = seedSchedule(l);
    const ids = ['2026-03-03','2026-03-10','2026-03-17','2026-03-24'].map(d => seedAttendance(l, c, d));
    ids.slice(0,3).forEach(id => updateAttendance(id, 'normal'));
    const r = updateAttendance(ids[3], 'normal');
    expect(r.status).toBe('fail');
  });
  test('excused는 카운트 변동 없음', () => {
    const s = seedSemester(), l = seedLecture(s), c = seedSchedule(l);
    const a = seedAttendance(l, c, '2026-03-03');
    expect(updateAttendance(a, 'excused').absenceCount).toBe(0);
  });
  test('professor_cancel은 카운트 변동 없음', () => {
    const s = seedSemester(), l = seedLecture(s), c = seedSchedule(l);
    const a = seedAttendance(l, c, '2026-03-03');
    expect(updateAttendance(a, 'professor_cancel').absenceCount).toBe(0);
  });
  test('online: 카운트 변동 없음, isOnlineTaskCompleted=1', () => {
    const s = seedSemester(), l = seedLecture(s), c = seedSchedule(l);
    const a = seedAttendance(l, c, '2026-03-03');
    const r = updateAttendance(a, 'online', true);
    expect(r.absenceCount).toBe(0);
    expect(r.attendance.isOnlineTaskCompleted).toBe(1);
  });
  test('holiday는 카운트 변동 없음', () => {
    const s = seedSemester(), l = seedLecture(s), c = seedSchedule(l);
    const a = seedAttendance(l, c, '2026-03-03');
    expect(updateAttendance(a, 'holiday').absenceCount).toBe(0);
  });
});

// ── 3. saveFinalSchedule ─────────────────────────────────────────────────────
describe('saveFinalSchedule', () => {
  test('유효한 단일 강의 저장 성공', () => {
    const s = seedSemester();
    const { saved, skipped } = saveFinalSchedule(s, [{
      className: '데이터구조', professor: '홍길동',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00', classroom: 'IT관 201' }],
    }]);
    expect(saved.length).toBe(1);
    expect(skipped.length).toBe(0);
    expect(saved[0].weeklyCount).toBe(1);
    expect(saved[0].maxAbsenceAllowed).toBe(3);
  });
  test('화/목 수업(주 2회): weeklyCount=2, maxAbsenceAllowed=6', () => {
    const s = seedSemester();
    const { saved } = saveFinalSchedule(s, [{
      className: '알고리즘',
      schedules: [
        { dayOfWeek: 1, startTime: '10:00', endTime: '11:30', classroom: 'E관 501' },
        { dayOfWeek: 3, startTime: '10:00', endTime: '11:30', classroom: 'E관 501' },
      ],
    }]);
    expect(saved[0].weeklyCount).toBe(2);
    expect(saved[0].maxAbsenceAllowed).toBe(6);
  });
  test('강의명 누락 → skipped에 포함', () => {
    const s = seedSemester();
    const { saved, skipped } = saveFinalSchedule(s, [
      { className: '', schedules: [{ dayOfWeek: 0, startTime: '09:00', endTime: '10:00' }] },
      { className: '유효강의', schedules: [{ dayOfWeek: 0, startTime: '09:00', endTime: '10:00' }] },
    ]);
    expect(saved.length).toBe(1);
    expect(skipped.length).toBe(1);
  });
  test('시간 역전 스케줄 → skipped에 포함', () => {
    const s = seedSemester();
    const { saved, skipped } = saveFinalSchedule(s, [{
      className: '오류강의',
      schedules: [{ dayOfWeek: 0, startTime: '12:00', endTime: '09:00' }],
    }]);
    expect(saved.length).toBe(0);
    expect(skipped.length).toBe(1);
  });
  test('잘못된 dayOfWeek(7이상) → skipped', () => {
    const s = seedSemester();
    const { skipped } = saveFinalSchedule(s, [{
      className: '오류강의2',
      schedules: [{ dayOfWeek: 7, startTime: '10:00', endTime: '12:00' }],
    }]);
    expect(skipped.length).toBe(1);
  });
  test('Upsert: Lecture ID 및 LectureSchedule ID 보존', () => {
    const s = seedSemester();
    const { saved: f } = saveFinalSchedule(s, [{
      className: '운영체제',
      schedules: [{ dayOfWeek: 2, startTime: '14:00', endTime: '16:00', classroom: 'IT관 301' }],
    }]);
    const fSchId = db.prepare('SELECT id FROM LectureSchedule WHERE lectureId=?').get(f[0].id).id;
    const { saved: sec } = saveFinalSchedule(s, [{
      className: '운영체제',
      schedules: [{ dayOfWeek: 2, startTime: '14:00', endTime: '17:00', classroom: 'IT관 302' }],
    }]);
    const sSchId = db.prepare('SELECT id FROM LectureSchedule WHERE lectureId=?').get(sec[0].id).id;
    expect(f[0].id).toBe(sec[0].id);
    expect(fSchId).toBe(sSchId);
    const sch = db.prepare('SELECT * FROM LectureSchedule WHERE id=?').get(sSchId);
    expect(sch.classroom).toBe('IT관 302');
    expect(sch.endTime).toBe('17:00');
  });
  test('삭제된 시간대는 Attendance도 함께 제거', () => {
    const s = seedSemester();
    saveFinalSchedule(s, [{
      className: '축소강의',
      schedules: [
        { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' },
        { dayOfWeek: 3, startTime: '10:00', endTime: '12:00' },
      ],
    }]);
    const lec    = db.prepare("SELECT id FROM Lecture WHERE className='축소강의'").get();
    const thuSch = db.prepare('SELECT id FROM LectureSchedule WHERE lectureId=? AND dayOfWeek=3').get(lec.id);
    db.prepare('INSERT INTO Attendance (lectureId, lectureScheduleId, date, absenceType) VALUES (?,?,?,?)')
      .run(lec.id, thuSch.id, '2026-03-05', 'present');
    saveFinalSchedule(s, [{
      className: '축소강의',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }],
    }]);
    expect(db.prepare('SELECT COUNT(*) as c FROM LectureSchedule WHERE lectureId=?').get(lec.id).c).toBe(1);
    expect(db.prepare('SELECT COUNT(*) as c FROM Attendance WHERE lectureId=?').get(lec.id).c).toBe(0);
  });
  test('없는 semesterId → 에러', () => {
    expect(() => saveFinalSchedule(9999, [{
      className: '테스트',
      schedules: [{ dayOfWeek: 0, startTime: '09:00', endTime: '10:00' }],
    }])).toThrow(/없음/);
  });
});

// ── 4. generateAttendanceRecords ────────────────────────────────────────────
describe('generateAttendanceRecords', () => {
  test('화요일 날짜에만 Attendance 행 생성', () => {
    const s = seedSemester({ startDate: '2026-03-02', endDate: '2026-03-31' });
    const { saved } = saveFinalSchedule(s, [{
      className: '화요일강의',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }],
    }]);
    generateAttendanceRecords(s);
    const atts = db.prepare('SELECT * FROM Attendance WHERE lectureId=?').all(saved[0].id);
    expect(atts.length).toBeGreaterThan(0);
    atts.forEach(a => {
      expect(new Date(a.date + 'T00:00:00').getDay()).toBe(2);
    });
  });
  test('날짜 경계 안에서만 생성', () => {
    const s = seedSemester({ startDate: '2026-03-02', endDate: '2026-03-10' });
    const { saved } = saveFinalSchedule(s, [{
      className: '경계테스트',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }],
    }]);
    generateAttendanceRecords(s);
    db.prepare('SELECT * FROM Attendance WHERE lectureId=?').all(saved[0].id)
      .forEach(a => {
        expect(a.date >= '2026-03-02').toBe(true);
        expect(a.date <= '2026-03-10').toBe(true);
      });
  });
  test('공휴일(2026-03-02 삼일절 대체)는 holiday로 자동 설정', () => {
    const s = seedSemester({ startDate: '2026-03-01', endDate: '2026-03-07' });
    const { saved } = saveFinalSchedule(s, [{
      className: '월요일강의',
      schedules: [{ dayOfWeek: 0, startTime: '09:00', endTime: '10:00' }],
    }]);
    generateAttendanceRecords(s);
    const att = db.prepare("SELECT * FROM Attendance WHERE lectureId=? AND date='2026-03-02'").get(saved[0].id);
    expect(att).toBeDefined();
    expect(att.absenceType).toBe('holiday');
  });
  test('일반 날짜는 present로 생성', () => {
    const s = seedSemester({ startDate: '2026-04-06', endDate: '2026-04-12' });
    const { saved } = saveFinalSchedule(s, [{
      className: '일반강의',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }],
    }]);
    generateAttendanceRecords(s);
    const att = db.prepare("SELECT * FROM Attendance WHERE lectureId=? AND date='2026-04-07'").get(saved[0].id);
    expect(att).toBeDefined();
    expect(att.absenceType).toBe('present');
  });
  test('두 번 호이도 중복 없음', () => {
    const s = seedSemester({ startDate: '2026-03-02', endDate: '2026-03-31' });
    const { saved } = saveFinalSchedule(s, [{
      className: '중복방지강의',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }],
    }]);
    generateAttendanceRecords(s);
    const c1 = db.prepare('SELECT COUNT(*) as c FROM Attendance WHERE lectureId=?').get(saved[0].id).c;
    generateAttendanceRecords(s);
    const c2 = db.prepare('SELECT COUNT(*) as c FROM Attendance WHERE lectureId=?').get(saved[0].id).c;
    expect(c1).toBe(c2);
    expect(c1).toBeGreaterThan(0);
  });
  test('시간표 수정 후 재실행: 유저 데이터(normal) 보존', () => {
    const s = seedSemester({ startDate: '2026-03-02', endDate: '2026-03-31' });
    saveFinalSchedule(s, [{
      className: '마이그레이션테스트',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '12:00', classroom: '구관' }],
    }]);
    generateAttendanceRecords(s);
    const first = db.prepare("SELECT id FROM Attendance WHERE absenceType='present' ORDER BY date LIMIT 1").get();
    db.prepare("UPDATE Attendance SET absenceType='normal' WHERE id=?").run(first.id);
    saveFinalSchedule(s, [{
      className: '마이그레이션테스트',
      schedules: [{ dayOfWeek: 1, startTime: '10:00', endTime: '13:00', classroom: '신관' }],
    }]);
    generateAttendanceRecords(s);
    const preserved = db.prepare('SELECT * FROM Attendance WHERE id=?').get(first.id);
    expect(preserved.absenceType).toBe('normal');
  });
});
