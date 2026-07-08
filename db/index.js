// db/index.js  —  SQLite 연결 & 스키마 초기화
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

const SCHEMA_SQL = `
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

  CREATE TABLE IF NOT EXISTS AuditNode (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id  INTEGER REFERENCES AuditNode(id) ON DELETE CASCADE,
    level      INTEGER NOT NULL CHECK(level BETWEEN 1 AND 4),
    name       TEXT    NOT NULL,
    excel_path TEXT
  );

  CREATE TABLE IF NOT EXISTS AuditSession (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES AuditNode(id) ON DELETE CASCADE,
    status      TEXT    NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','pending','done')),
    created_at  TEXT    NOT NULL,
    last_active TEXT    NOT NULL,
    notes       TEXT    NOT NULL DEFAULT '',
    todos       TEXT    NOT NULL DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_audit_node_parent    ON AuditNode(parent_id);
  CREATE INDEX IF NOT EXISTS idx_audit_session_status ON AuditSession(status);
`;

function initSchema(db) {
  db.exec(SCHEMA_SQL);
}

module.exports = { getDb, initSchema, SCHEMA_SQL };
