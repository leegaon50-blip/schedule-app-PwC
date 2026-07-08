// services/attendanceService.js  —  출결 업데이트 & 상태 재계산
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
    throw new Error(`유효하지 않은 absenceType: ${newType}`);
  }

  return db.transaction(() => {
    const prev = db.prepare('SELECT * FROM Attendance WHERE id = ?').get(attendanceId);
    if (!prev) throw new Error(`Attendance id=${attendanceId} 없음`);

    const lecture = db.prepare('SELECT * FROM Lecture WHERE id = ?').get(prev.lectureId);
    if (!lecture) throw new Error(`Lecture id=${prev.lectureId} 없음`);

    db.prepare(`
      UPDATE Attendance
         SET absenceType           = ?,
             isOnlineTaskCompleted = ?,
             updatedAt             = datetime('now')
       WHERE id = ?
    `).run(newType, isOnlineTaskCompleted ? 1 : 0, attendanceId);

    const { count: newAbsenceCount } = db.prepare(`
      SELECT COUNT(*) AS count
        FROM Attendance
       WHERE lectureId = ? AND absenceType = 'normal'
    `).get(prev.lectureId);

    const newStatus = calcStatus(newAbsenceCount, lecture.maxAbsenceAllowed);
    const remaining = lecture.maxAbsenceAllowed - newAbsenceCount;

    db.prepare(`
      UPDATE Lecture
         SET absenceCount = ?,
             status       = ?,
             updatedAt    = datetime('now')
       WHERE id = ?
    `).run(newAbsenceCount, newStatus, lecture.id);

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
