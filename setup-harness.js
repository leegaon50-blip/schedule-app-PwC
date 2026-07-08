#!/usr/bin/env node
// setup-harness.js  —  테스트 하네스 파일 자동 조립 스크립트
// 사용법: C:\schedule-app> node setup-harness.js
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = __dirname;

function write(relPath, content) {
  const full = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  console.log('  ✅  ' + relPath);
}

console.log('\n🔧 schedule-app 테스트 하네스 조립 시작...\n');

// ════════════════════════════════════════════════════════
// 1. package.json
// ════════════════════════════════════════════════════════
write('package.json',
`{
  "name": "일정 관리",
  "version": "1.0.0",
  "description": "일정 관리 데스크탑 앱",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test":  "jest"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "commonjs",
  "devDependencies": {
    "electron": "^42.3.0",
    "jest": "^30.4.2"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0"
  },
  "jest": {
    "testEnvironment": "node",
    "testMatch": ["**/*.test.js"],
    "testPathIgnorePatterns": ["/node_modules/"],
    "verbose": true
  }
}
`);

// ════════════════════════════════════════════════════════
// 2. db/index.js
// ════════════════════════════════════════════════════════
write('db/index.js',
`// db/index.js  —  SQLite 연결 & 스키마 초기화
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

let _db;

function getDb() {
  if (_db) return _db;

  let dbPath;
  try {
    const { app } = require('electron');
    dbPath = path.join(app.getPath('userData'), 'schedule.db');
  } catch {
    dbPath = path.join(__dirname, '..', 'schedule.db');
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

const SCHEMA_SQL = \`
  CREATE TABLE IF NOT EXISTS Semester (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    startDate TEXT    NOT NULL,
    endDate   TEXT    NOT NULL,
    isActive  INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS Lecture (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    semesterId        INTEGER NOT NULL REFERENCES Semester(id) ON DELETE CASCADE,
    className         TEXT    NOT NULL,
    professor         TEXT,
    weeklyCount       INTEGER NOT NULL DEFAULT 1,
    maxAbsenceAllowed INTEGER NOT NULL,
    absenceCount      INTEGER NOT NULL DEFAULT 0,
    status            TEXT    NOT NULL DEFAULT 'safe',
    color             TEXT    NOT NULL DEFAULT '#3B82F6',
    memo              TEXT,
    createdAt         TEXT    DEFAULT (datetime('now')),
    updatedAt         TEXT    DEFAULT (datetime('now')),
    UNIQUE(semesterId, className)
  );

  CREATE TABLE IF NOT EXISTS LectureSchedule (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    lectureId INTEGER NOT NULL REFERENCES Lecture(id) ON DELETE CASCADE,
    dayOfWeek INTEGER NOT NULL,
    startTime TEXT    NOT NULL,
    endTime   TEXT    NOT NULL,
    classroom TEXT
  );

  CREATE TABLE IF NOT EXISTS Attendance (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    lectureId             INTEGER NOT NULL REFERENCES Lecture(id) ON DELETE CASCADE,
    lectureScheduleId     INTEGER NOT NULL REFERENCES LectureSchedule(id),
    date                  TEXT    NOT NULL,
    absenceType           TEXT    NOT NULL DEFAULT 'present',
    isOnlineTaskCompleted INTEGER NOT NULL DEFAULT 0,
    memo                  TEXT,
    createdAt             TEXT    DEFAULT (datetime('now')),
    updatedAt             TEXT    DEFAULT (datetime('now')),
    UNIQUE(lectureScheduleId, date)
  );

  CREATE INDEX IF NOT EXISTS idx_att_lecture_date ON Attendance(lectureId, date);
\`;

function initSchema(db) {
  db.exec(SCHEMA_SQL);
}

module.exports = { getDb, initSchema, SCHEMA_SQL };
`);

// ════════════════════════════════════════════════════════
// 3. services/attendanceService.js
// ════════════════════════════════════════════════════════
write('services/attendanceService.js',
`// services/attendanceService.js  —  출결 업데이트 & 상태 재계산
'use strict';

const { getDb } = require('../db/index');

const VALID_TYPES = new Set([
  'present', 'normal', 'excused', 'professor_cancel',
  'online', 'holiday', 'week1',
]);

function calcMaxAbsence(weeklyCount) {
  if (weeklyCount === 1) return 3;
  if (weeklyCount === 2) return 6;
  return Math.round(weeklyCount * 3);
}

function calcStatus(absenceCount, maxAbsenceAllowed) {
  if (absenceCount > maxAbsenceAllowed) return 'fail';
  const remaining = maxAbsenceAllowed - absenceCount;
  if (remaining === 0) return 'danger';
  if (remaining === 1) return 'caution';
  return 'safe';
}

function updateAttendance(attendanceId, newType, isOnlineTaskCompleted = false) {
  const db = getDb();

  if (!VALID_TYPES.has(newType)) {
    throw new Error(\`유효하지 않은 absenceType: \${newType}\`);
  }

  return db.transaction(() => {
    const prev = db.prepare('SELECT * FROM Attendance WHERE id = ?').get(attendanceId);
    if (!prev) throw new Error(\`Attendance id=\${attendanceId} 없음\`);

    const lecture = db.prepare('SELECT * FROM Lecture WHERE id = ?').get(prev.lectureId);
    if (!lecture) throw new Error(\`Lecture id=\${prev.lectureId} 없음\`);

    db.prepare(\`
      UPDATE Attendance
         SET absenceType           = ?,
             isOnlineTaskCompleted = ?,
             updatedAt             = datetime('now')
       WHERE id = ?
    \`).run(newType, isOnlineTaskCompleted ? 1 : 0, attendanceId);

    const { count: newAbsenceCount } = db.prepare(\`
      SELECT COUNT(*) AS count
        FROM Attendance
       WHERE lectureId = ? AND absenceType = 'normal'
    \`).get(prev.lectureId);

    const newStatus = calcStatus(newAbsenceCount, lecture.maxAbsenceAllowed);
    const remaining = lecture.maxAbsenceAllowed - newAbsenceCount;

    db.prepare(\`
      UPDATE Lecture
         SET absenceCount = ?,
             status       = ?,
             updatedAt    = datetime('now')
       WHERE id = ?
    \`).run(newAbsenceCount, newStatus, lecture.id);

    return {
      lectureId:         lecture.id,
      className:         lecture.className,
      absenceCount:      newAbsenceCount,
      maxAbsenceAllowed: lecture.maxAbsenceAllowed,
      remaining,
      status:            newStatus,
      attendance:        db.prepare('SELECT * FROM Attendance WHERE id = ?').get(attendanceId),
    };
  })();
}

module.exports = { updateAttendance, calcMaxAbsence, calcStatus };
`);

// ════════════════════════════════════════════════════════
// 4. services/scheduleService.js
// ════════════════════════════════════════════════════════
write('services/scheduleService.js',
`// services/scheduleService.js  —  시간표 확정 저장 & 출결 자동 생성
'use strict';

const { getDb }          = require('../db/index');
const { calcMaxAbsence } = require('./attendanceService');

const HOLIDAYS = new Set([
  '2026-01-01',
  '2026-02-16','2026-02-17','2026-02-18',
  '2026-03-01','2026-03-02',
  '2026-05-05',
  '2026-05-24',
  '2026-06-06','2026-06-08',
  '2026-08-15','2026-08-17',
  '2026-09-24','2026-09-25','2026-09-26','2026-09-28',
  '2026-10-03','2026-10-05',
  '2026-10-09',
  '2026-12-25',
  '2027-01-01',
  '2027-02-07','2027-02-08','2027-02-09',
  '2027-03-01',
  '2027-05-05',
  '2027-05-13',
  '2027-06-06','2027-06-07',
  '2027-08-15','2027-08-16',
  '2027-10-03','2027-10-04',
  '2027-10-09','2027-10-11',
  '2027-12-25',
]);

const TIME_RE    = /^\\d{2}:\\d{2}$/;
const VALID_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

function validateLecture(lec, idx) {
  if (!lec.className?.trim())
    return \`[\${idx}] className 필수\`;
  if (!Array.isArray(lec.schedules) || lec.schedules.length === 0)
    return \`[\${idx}] schedules 필수\`;
  for (const s of lec.schedules) {
    if (!VALID_DAYS.has(s.dayOfWeek))
      return \`[\${idx}] 잘못된 dayOfWeek: \${s.dayOfWeek}\`;
    if (!TIME_RE.test(s.startTime))
      return \`[\${idx}] 잘못된 startTime: "\${s.startTime}"\`;
    if (!TIME_RE.test(s.endTime))
      return \`[\${idx}] 잘못된 endTime: "\${s.endTime}"\`;
    if (s.startTime >= s.endTime)
      return \`[\${idx}] startTime ≥ endTime (\${s.startTime} ~ \${s.endTime})\`;
  }
  return null;
}

function saveFinalSchedule(semesterId, parsedLectures) {
  const db = getDb();

  if (!db.prepare('SELECT id FROM Semester WHERE id = ?').get(semesterId)) {
    throw new Error(\`Semester id=\${semesterId} 없음\`);
  }

  const saved   = [];
  const skipped = [];

  db.transaction(() => {
    for (let i = 0; i < parsedLectures.length; i++) {
      const lec = parsedLectures[i];
      const err = validateLecture(lec, i);
      if (err) { skipped.push(err); continue; }

      const className         = lec.className.trim();
      const weeklyCount       = lec.schedules.length;
      const maxAbsenceAllowed = calcMaxAbsence(weeklyCount);

      const existing = db.prepare(
        'SELECT id FROM Lecture WHERE semesterId = ? AND className = ?'
      ).get(semesterId, className);

      let lectureId;

      if (existing) {
        db.prepare(\`
          UPDATE Lecture
             SET professor         = ?,
                 weeklyCount       = ?,
                 maxAbsenceAllowed = ?,
                 color             = COALESCE(?, color),
                 updatedAt         = datetime('now')
           WHERE id = ?
        \`).run(lec.professor ?? null, weeklyCount, maxAbsenceAllowed,
               lec.color ?? null, existing.id);
        lectureId = existing.id;
      } else {
        const res = db.prepare(\`
          INSERT INTO Lecture
            (semesterId, className, professor, weeklyCount, maxAbsenceAllowed, color)
          VALUES (?, ?, ?, ?, ?, ?)
        \`).run(semesterId, className, lec.professor ?? null,
               weeklyCount, maxAbsenceAllowed, lec.color ?? '#3B82F6');
        lectureId = res.lastInsertRowid;
      }

      const oldSchedules = db.prepare(
        'SELECT * FROM LectureSchedule WHERE lectureId = ?'
      ).all(lectureId);

      const oldMap  = new Map(oldSchedules.map(s => [\`\${s.dayOfWeek}-\${s.startTime}\`, s]));
      const newKeys = new Set();

      for (const s of lec.schedules) {
        const key = \`\${s.dayOfWeek}-\${s.startTime}\`;
        newKeys.add(key);

        if (oldMap.has(key)) {
          db.prepare(\`
            UPDATE LectureSchedule SET endTime = ?, classroom = ? WHERE id = ?
          \`).run(s.endTime, s.classroom ?? null, oldMap.get(key).id);
        } else {
          db.prepare(\`
            INSERT INTO LectureSchedule (lectureId, dayOfWeek, startTime, endTime, classroom)
            VALUES (?, ?, ?, ?, ?)
          \`).run(lectureId, s.dayOfWeek, s.startTime, s.endTime, s.classroom ?? null);
        }
      }

      for (const [key, old] of oldMap) {
        if (!newKeys.has(key)) {
          db.prepare('DELETE FROM Attendance      WHERE lectureScheduleId = ?').run(old.id);
          db.prepare('DELETE FROM LectureSchedule WHERE id = ?').run(old.id);
        }
      }

      saved.push(db.prepare('SELECT * FROM Lecture WHERE id = ?').get(lectureId));
    }
  })();

  return { saved, skipped };
}

function generateAttendanceRecords(semesterId) {
  const db       = getDb();
  const semester = db.prepare('SELECT * FROM Semester WHERE id = ?').get(semesterId);
  if (!semester) throw new Error(\`Semester id=\${semesterId} 없음\`);

  const stmtFindExact = db.prepare(\`
    SELECT id FROM Attendance WHERE lectureScheduleId = ? AND date = ?
  \`);
  const stmtFindOrphan = db.prepare(\`
    SELECT id FROM Attendance
     WHERE lectureId = ? AND date = ? AND lectureScheduleId != ?
     LIMIT 1
  \`);
  const stmtMigrate = db.prepare(\`
    UPDATE Attendance SET lectureScheduleId = ?, updatedAt = datetime('now') WHERE id = ?
  \`);
  const stmtInsert = db.prepare(\`
    INSERT OR IGNORE INTO Attendance (lectureId, lectureScheduleId, date, absenceType)
    VALUES (?, ?, ?, ?)
  \`);

  const toJsDay = d => (d + 1) % 7;
  const toLocalDateStr = d =>
    \`\${d.getFullYear()}-\${String(d.getMonth()+1).padStart(2,'0')}-\${String(d.getDate()).padStart(2,'0')}\`;

  db.transaction(() => {
    const lectures = db.prepare(
      'SELECT id FROM Lecture WHERE semesterId = ?'
    ).all(semesterId);

    for (const { id: lectureId } of lectures) {
      const schedules = db.prepare(
        'SELECT * FROM LectureSchedule WHERE lectureId = ?'
      ).all(lectureId);

      for (const sch of schedules) {
        const targetDay = toJsDay(sch.dayOfWeek);
        let   cur       = new Date(semester.startDate + 'T00:00:00');
        const end       = new Date(semester.endDate   + 'T00:00:00');

        while (cur <= end) {
          if (cur.getDay() === targetDay) {
            const dateStr = toLocalDateStr(cur);

            if (stmtFindExact.get(sch.id, dateStr)) {
              cur.setDate(cur.getDate() + 1);
              continue;
            }

            const orphan = stmtFindOrphan.get(lectureId, dateStr, sch.id);
            if (orphan) {
              stmtMigrate.run(sch.id, orphan.id);
              cur.setDate(cur.getDate() + 1);
              continue;
            }

            stmtInsert.run(lectureId, sch.id, dateStr,
                           HOLIDAYS.has(dateStr) ? 'holiday' : 'present');
          }
          cur.setDate(cur.getDate() + 1);
        }
      }
    }
  })();
}

module.exports = { saveFinalSchedule, generateAttendanceRecords, HOLIDAYS };
`);

// ════════════════════════════════════════════════════════
// 5. tests/attendance.test.js
// ════════════════════════════════════════════════════════
write('tests/attendance.test.js',
`// tests/attendance.test.js
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
  db.exec(\`
    DELETE FROM Attendance;
    DELETE FROM LectureSchedule;
    DELETE FROM Lecture;
    DELETE FROM Semester;
  \`);
  try {
    db.exec(\`
      DELETE FROM sqlite_sequence
       WHERE name IN ('Attendance','LectureSchedule','Lecture','Semester');
    \`);
  } catch { /* sqlite_sequence may not exist yet */ }
});

function seedSemester({ name='2026-1학기', startDate='2026-03-02', endDate='2026-06-19' } = {}) {
  return db.prepare('INSERT INTO Semester (name, startDate, endDate) VALUES (?, ?, ?)')
    .run(name, startDate, endDate).lastInsertRowid;
}
function seedLecture(semId, { className='테스트강의', weeklyCount=1, maxOverride } = {}) {
  const max = maxOverride ?? calcMaxAbsence(weeklyCount);
  return db.prepare(\`
    INSERT INTO Lecture (semesterId, className, weeklyCount, maxAbsenceAllowed)
    VALUES (?, ?, ?, ?)
  \`).run(semId, className, weeklyCount, max).lastInsertRowid;
}
function seedSchedule(lecId, { dayOfWeek=1, startTime='10:00', endTime='12:00', classroom='IT관 201' } = {}) {
  return db.prepare(\`
    INSERT INTO LectureSchedule (lectureId, dayOfWeek, startTime, endTime, classroom)
    VALUES (?, ?, ?, ?, ?)
  \`).run(lecId, dayOfWeek, startTime, endTime, classroom).lastInsertRowid;
}
function seedAttendance(lecId, schId, date, absenceType='present') {
  return db.prepare(\`
    INSERT INTO Attendance (lectureId, lectureScheduleId, date, absenceType)
    VALUES (?, ?, ?, ?)
  \`).run(lecId, schId, date, absenceType).lastInsertRowid;
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
`);

// ════════════════════════════════════════════════════════
// 6. .github/workflows/test.yml
// ════════════════════════════════════════════════════════
write('.github/workflows/test.yml',
`name: Jest Tests

on:
  push:
    branches: [ main ]
    paths:
      - 'services/**'
      - 'db/**'
      - 'tests/**'
      - '*.test.js'
      - 'package.json'
  pull_request:
    branches: [ main ]
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'

      - name: Run Jest tests
        run: npm test

      - name: Coverage summary
        if: always()
        run: npx jest --coverage --coverageReporters=text-summary
        env:
          ELECTRON_SKIP_BINARY_DOWNLOAD: '1'
        continue-on-error: true
`);

console.log('\n🎉 완료! 생성된 파일 목록:');
console.log('   package.json');
console.log('   db/index.js');
console.log('   services/attendanceService.js');
console.log('   services/scheduleService.js');
console.log('   tests/attendance.test.js');
console.log('   .github/workflows/test.yml');
console.log('\n실행: node setup-harness.js');
console.log('테스트: npm test\n');
