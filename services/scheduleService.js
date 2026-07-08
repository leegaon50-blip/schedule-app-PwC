// services/scheduleService.js  —  시간표 확정 저장 & 출결 자동 생성
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

const TIME_RE    = /^\d{2}:\d{2}$/;
const VALID_DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

function validateLecture(lec, idx) {
  if (!lec.className?.trim())
    return `[${idx}] className 필수`;
  if (!Array.isArray(lec.schedules) || lec.schedules.length === 0)
    return `[${idx}] schedules 필수`;
  for (const s of lec.schedules) {
    if (!VALID_DAYS.has(s.dayOfWeek))
      return `[${idx}] 잘못된 dayOfWeek: ${s.dayOfWeek}`;
    if (!TIME_RE.test(s.startTime))
      return `[${idx}] 잘못된 startTime: "${s.startTime}"`;
    if (!TIME_RE.test(s.endTime))
      return `[${idx}] 잘못된 endTime: "${s.endTime}"`;
    if (s.startTime >= s.endTime)
      return `[${idx}] startTime ≥ endTime (${s.startTime} ~ ${s.endTime})`;
  }
  return null;
}

function saveFinalSchedule(semesterId, parsedLectures) {
  const db = getDb();

  if (!db.prepare('SELECT id FROM Semester WHERE id = ?').get(semesterId)) {
    throw new Error(`Semester id=${semesterId} 없음`);
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
        db.prepare(`
          UPDATE Lecture
             SET professor         = ?,
                 weeklyCount       = ?,
                 maxAbsenceAllowed = ?,
                 color             = COALESCE(?, color),
                 updatedAt         = datetime('now')
           WHERE id = ?
        `).run(lec.professor ?? null, weeklyCount, maxAbsenceAllowed,
               lec.color ?? null, existing.id);
        lectureId = existing.id;
      } else {
        const res = db.prepare(`
          INSERT INTO Lecture
            (semesterId, className, professor, weeklyCount, maxAbsenceAllowed, color)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(semesterId, className, lec.professor ?? null,
               weeklyCount, maxAbsenceAllowed, lec.color ?? '#3B82F6');
        lectureId = res.lastInsertRowid;
      }

      const oldSchedules = db.prepare(
        'SELECT * FROM LectureSchedule WHERE lectureId = ?'
      ).all(lectureId);

      const oldMap  = new Map(oldSchedules.map(s => [`${s.dayOfWeek}-${s.startTime}`, s]));
      const newKeys = new Set();

      for (const s of lec.schedules) {
        const key = `${s.dayOfWeek}-${s.startTime}`;
        newKeys.add(key);

        if (oldMap.has(key)) {
          db.prepare(`
            UPDATE LectureSchedule SET endTime = ?, classroom = ? WHERE id = ?
          `).run(s.endTime, s.classroom ?? null, oldMap.get(key).id);
        } else {
          db.prepare(`
            INSERT INTO LectureSchedule (lectureId, dayOfWeek, startTime, endTime, classroom)
            VALUES (?, ?, ?, ?, ?)
          `).run(lectureId, s.dayOfWeek, s.startTime, s.endTime, s.classroom ?? null);
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
  if (!semester) throw new Error(`Semester id=${semesterId} 없음`);

  const stmtFindExact = db.prepare(`
    SELECT id FROM Attendance WHERE lectureScheduleId = ? AND date = ?
  `);
  const stmtFindOrphan = db.prepare(`
    SELECT id FROM Attendance
     WHERE lectureId = ? AND date = ? AND lectureScheduleId != ?
     LIMIT 1
  `);
  const stmtMigrate = db.prepare(`
    UPDATE Attendance SET lectureScheduleId = ?, updatedAt = datetime('now') WHERE id = ?
  `);
  const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO Attendance (lectureId, lectureScheduleId, date, absenceType)
    VALUES (?, ?, ?, ?)
  `);

  const toJsDay = d => (d + 1) % 7;
  const toLocalDateStr = d =>
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

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
