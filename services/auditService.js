'use strict';
const fs   = require('fs');
const path = require('path');
const { getDb } = require('../db/index');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'audit_snapshot.json');

function _now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ── 입력 가드 ─────────────────────────────────────────────────────────────────
// better-sqlite3는 ? 플레이스홀더로 SQL Injection을 원천 차단하나,
// 너무 긴 문자열이나 깨진 JSON 으로 인한 DB 오류는 여기서 방어한다.

const MAX_NAME_LEN  = 200;
const MAX_NOTES_LEN = 5000;
const MAX_TODO_LEN  = 500;

function _guardStr(s, maxLen) {
  if (s == null) return null;
  return String(s).trim().slice(0, maxLen);
}

function _safeTodos(todos) {
  if (!Array.isArray(todos)) return '[]';
  try {
    return JSON.stringify(
      todos.map(t => ({
        text: String(t.text ?? '').slice(0, MAX_TODO_LEN),
        done: !!t.done,
      }))
    );
  } catch (e) {
    console.error('[AuditService] _safeTodos 직렬화 오류:', e.message);
    return '[]';
  }
}

// ── AuditNode ─────────────────────────────────────────────────────────────────

function getChildren(parentId) {
  try {
    const db = getDb();
    if (parentId === null || parentId === undefined) {
      return db.prepare(
        'SELECT * FROM AuditNode WHERE parent_id IS NULL ORDER BY name'
      ).all();
    }
    return db.prepare(
      'SELECT * FROM AuditNode WHERE parent_id = ? ORDER BY name'
    ).all(parentId);
  } catch (e) {
    console.error('[AuditService] getChildren error:', e.message);
    return [];
  }
}

function getNode(id) {
  try {
    return getDb().prepare('SELECT * FROM AuditNode WHERE id = ?').get(id) || null;
  } catch (e) {
    console.error('[AuditService] getNode error:', e.message);
    return null;
  }
}

function addNode(parentId, level, name, excelPath = null) {
  try {
    const res = getDb().prepare(
      'INSERT INTO AuditNode (parent_id, level, name, excel_path) VALUES (?,?,?,?)'
    ).run(parentId ?? null, level, _guardStr(name, MAX_NAME_LEN), excelPath ?? null);
    return res.lastInsertRowid;
  } catch (e) {
    console.error('[AuditService] addNode error:', e.message);
    return null;
  }
}

function updateNode(id, name, excelPath = null) {
  try {
    getDb().prepare(
      'UPDATE AuditNode SET name = ?, excel_path = ? WHERE id = ?'
    ).run(_guardStr(name, MAX_NAME_LEN), excelPath ?? null, id);
  } catch (e) {
    console.error('[AuditService] updateNode error:', e.message);
  }
}

function deleteNode(id) {
  try {
    getDb().prepare('DELETE FROM AuditNode WHERE id = ?').run(id);
  } catch (e) {
    console.error('[AuditService] deleteNode error:', e.message);
  }
}

function getNodePath(nodeId) {
  try {
    const db = getDb();
    const parts = [];
    let id = nodeId;
    while (id != null) {
      const row = db.prepare(
        'SELECT id, name, parent_id FROM AuditNode WHERE id = ?'
      ).get(id);
      if (!row) break;
      parts.unshift(row.name);
      id = row.parent_id;
    }
    return parts.join(' > ');
  } catch (e) {
    console.error('[AuditService] getNodePath error:', e.message);
    return '';
  }
}

// Returns { basename: nodeId } for all level-4 nodes with excel_path set
function getAllL4Mappings() {
  try {
    const rows = getDb().prepare(
      "SELECT id, excel_path FROM AuditNode WHERE level = 4 AND excel_path IS NOT NULL AND excel_path != ''"
    ).all();
    const map = {};
    for (const row of rows) map[path.basename(row.excel_path)] = row.id;
    return map;
  } catch (e) {
    console.error('[AuditService] getAllL4Mappings error:', e.message);
    return {};
  }
}

// ── AuditSession ──────────────────────────────────────────────────────────────

function createSession(nodeId) {
  try {
    const n = _now();
    const res = getDb().prepare(
      "INSERT INTO AuditSession (node_id, status, created_at, last_active) VALUES (?, 'active', ?, ?)"
    ).run(nodeId, n, n);
    return res.lastInsertRowid;
  } catch (e) {
    console.error('[AuditService] createSession error:', e.message);
    return null;
  }
}

function touchSession(sessionId) {
  try {
    getDb().prepare(
      'UPDATE AuditSession SET last_active = ? WHERE id = ?'
    ).run(_now(), sessionId);
  } catch (e) {
    console.error('[AuditService] touchSession error:', e.message);
  }
}

function saveSessionContent(sessionId, notes, todos) {
  try {
    getDb().prepare(
      'UPDATE AuditSession SET notes = ?, todos = ?, last_active = ? WHERE id = ?'
    ).run(_guardStr(notes, MAX_NOTES_LEN) ?? '', _safeTodos(todos), _now(), sessionId);
  } catch (e) {
    console.error('[AuditService] saveSessionContent error:', e.message);
  }
}

function moveSessionToPending(sessionId, notes, todos) {
  try {
    getDb().prepare(
      "UPDATE AuditSession SET status = 'pending', notes = ?, todos = ?, last_active = ? WHERE id = ?"
    ).run(_guardStr(notes, MAX_NOTES_LEN) ?? '', _safeTodos(todos), _now(), sessionId);
  } catch (e) {
    console.error('[AuditService] moveSessionToPending error:', e.message);
  }
}

function resumeSession(sessionId) {
  try {
    getDb().prepare(
      "UPDATE AuditSession SET status = 'active', last_active = ? WHERE id = ?"
    ).run(_now(), sessionId);
  } catch (e) {
    console.error('[AuditService] resumeSession error:', e.message);
  }
}

function restoreToPending(sessionId) {
  try {
    getDb().prepare(
      "UPDATE AuditSession SET status = 'pending', last_active = ? WHERE id = ?"
    ).run(_now(), sessionId);
  } catch (e) {
    console.error('[AuditService] restoreToPending error:', e.message);
  }
}

function completeSession(sessionId) {
  try {
    getDb().prepare(
      "UPDATE AuditSession SET status = 'done', last_active = ? WHERE id = ?"
    ).run(_now(), sessionId);
  } catch (e) {
    console.error('[AuditService] completeSession error:', e.message);
  }
}

function getSession(sessionId) {
  try {
    const row = getDb().prepare(`
      SELECT s.*,
             n.name AS task_name,
             p3.name AS l3_name, p2.name AS l2_name, p1.name AS company_name
      FROM AuditSession s
      JOIN  AuditNode n  ON s.node_id    = n.id
      LEFT JOIN AuditNode p3 ON n.parent_id  = p3.id
      LEFT JOIN AuditNode p2 ON p3.parent_id = p2.id
      LEFT JOIN AuditNode p1 ON p2.parent_id = p1.id
      WHERE s.id = ?
    `).get(sessionId);
    if (!row) return null;
    return { ...row, todos: JSON.parse(row.todos || '[]') };
  } catch (e) {
    console.error('[AuditService] getSession error:', e.message);
    return null;
  }
}

function _sessionListQuery(status) {
  return getDb().prepare(`
    SELECT s.*, n.name AS task_name,
           p3.name AS l3_name, p2.name AS l2_name, p1.name AS company_name
    FROM AuditSession s
    JOIN  AuditNode n  ON s.node_id    = n.id
    LEFT JOIN AuditNode p3 ON n.parent_id  = p3.id
    LEFT JOIN AuditNode p2 ON p3.parent_id = p2.id
    LEFT JOIN AuditNode p1 ON p2.parent_id = p1.id
    WHERE s.status = ?
    ORDER BY s.last_active DESC
  `).all(status);
}

function getPendingSessions() {
  try {
    return _sessionListQuery('pending');
  } catch (e) {
    console.error('[AuditService] getPendingSessions error:', e.message);
    return [];
  }
}

function getDoneSessions() {
  try {
    return _sessionListQuery('done');
  } catch (e) {
    console.error('[AuditService] getDoneSessions error:', e.message);
    return [];
  }
}

// 엑셀 열릴 때 호출 — pending 세션이 있으면 재개, 없으면 신규 생성
// 신규 생성 시에도 가장 최근 세션의 todos(done 포함)를 모두 상속해 복구
function getOrCreateActiveSession(nodeId) {
  try {
    const db = getDb();

    // ① 진행 중인 pending 세션 → 그대로 재개 (todos 전체 보존)
    const pending = db.prepare(
      "SELECT * FROM AuditSession WHERE node_id = ? AND status = 'pending' ORDER BY last_active DESC LIMIT 1"
    ).get(nodeId);
    if (pending) {
      resumeSession(pending.id);
      return {
        sessionId: pending.id,
        todos:     JSON.parse(pending.todos || '[]'),
        notes:     pending.notes || '',
        isResumed: true,
      };
    }

    // ② pending 없음 → 가장 최근 세션(done 포함)의 todos 전체를 상속
    const last = db.prepare(
      "SELECT todos FROM AuditSession WHERE node_id = ? ORDER BY last_active DESC LIMIT 1"
    ).get(nodeId);
    const inheritedTodos = last ? JSON.parse(last.todos || '[]') : [];

    // 새 세션 생성 + 상속 todos를 즉시 함께 INSERT
    const n   = _now();
    const res = db.prepare(
      "INSERT INTO AuditSession (node_id, status, created_at, last_active, todos) VALUES (?, 'active', ?, ?, ?)"
    ).run(nodeId, n, n, _safeTodos(inheritedTodos));

    return {
      sessionId: res.lastInsertRowid,
      todos:     inheritedTodos,
      notes:     '',
      isResumed: false,
    };
  } catch (e) {
    console.error('[AuditService] getOrCreateActiveSession error:', e.message);
    const sessionId = createSession(nodeId);
    return { sessionId, todos: [], notes: '', isResumed: false };
  }
}

// 칸반보드용 — L4 노드 전체 + 대표 세션(active>pending>done 우선) 결합
function getKanbanData() {
  try {
    const db = getDb();
    const nodes = db.prepare(`
      SELECT n.id, n.name, n.excel_path,
             p3.name AS l3_name, p2.name AS l2_name, p1.name AS company_name
      FROM AuditNode n
      LEFT JOIN AuditNode p3 ON n.parent_id  = p3.id
      LEFT JOIN AuditNode p2 ON p3.parent_id = p2.id
      LEFT JOIN AuditNode p1 ON p2.parent_id = p1.id
      WHERE n.level = 4
      ORDER BY p1.name, p2.name, p3.name, n.name
    `).all();

    // 세션 전체를 내려받아 JS에서 최적 세션 선택 (active>pending>done, 동순위면 최신)
    const sessions = db.prepare(
      'SELECT node_id, status, todos, last_active FROM AuditSession ORDER BY last_active DESC'
    ).all();
    const PRIO = { active: 1, pending: 2, done: 3 };
    const sessMap = {};
    for (const s of sessions) {
      const cur = sessMap[s.node_id];
      if (!cur || PRIO[s.status] < PRIO[cur.status]) sessMap[s.node_id] = s;
    }

    return nodes.map(n => ({
      nodeId:        n.id,
      nodeName:      n.name,
      excelPath:     n.excel_path          || null,
      companyName:   n.company_name        || '',
      l2Name:        n.l2_name             || '',
      l3Name:        n.l3_name             || '',
      sessionStatus: sessMap[n.id]?.status      || null,
      lastActive:    sessMap[n.id]?.last_active || null,
      todos:         JSON.parse(sessMap[n.id]?.todos || '[]'),
    }));
  } catch (e) {
    console.error('[AuditService] getKanbanData error:', e.message);
    return [];
  }
}

// Git 루트에 audit_snapshot.json 동기 쓰기 — auto_push.ps1이 이 파일을 push
function saveAuditSnapshotToDisk() {
  try {
    const snapshot = {
      ts:       new Date().toISOString(),
      nodes:    getAllNodes(),
      pending:  getPendingSessions(),
      done:     getDoneSessions(),
      kanban:   getKanbanData(),
      requests: getRequestItems(),
    };
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot), 'utf8');
    console.log(`[AuditService] audit_snapshot.json 저장 완료 → ${SNAPSHOT_PATH}`);
    return { ok: true };
  } catch (e) {
    console.error('[AuditService] audit_snapshot.json 저장 실패:', e.message);
    return { ok: false, error: e.message };
  }
}

// 트리 검색용 — 전체 노드를 한 번에 반환
function getAllNodes() {
  try {
    return getDb().prepare(
      'SELECT * FROM AuditNode ORDER BY level, parent_id, name'
    ).all();
  } catch (e) {
    console.error('[AuditService] getAllNodes error:', e.message);
    return [];
  }
}

// 모든 active/pending 세션에서 '? ' 또는 '/ ' 접두사를 가진 미완료 투두만 추출
function getRequestItems() {
  try {
    const rows = getDb().prepare(`
      SELECT s.id AS session_id, s.node_id, s.todos,
             n.name AS task_name, n.excel_path,
             p3.name AS l3_name, p2.name AS l2_name, p1.name AS company_name
      FROM AuditSession s
      JOIN  AuditNode n  ON s.node_id    = n.id
      LEFT JOIN AuditNode p3 ON n.parent_id  = p3.id
      LEFT JOIN AuditNode p2 ON p3.parent_id = p2.id
      LEFT JOIN AuditNode p1 ON p2.parent_id = p1.id
      WHERE s.status IN ('active', 'pending')
      ORDER BY p1.name, p2.name, p3.name, n.name
    `).all();

    const result = [];
    for (const row of rows) {
      const todos    = JSON.parse(row.todos || '[]');
      const requests = todos.filter(t => !t.done && /^\?\s/.test(t.text));
      const waiting  = todos.filter(t => !t.done && /^\/\s/.test(t.text));
      const received = todos.filter(t => !t.done && /^✓\s/.test(t.text));
      if (!requests.length && !waiting.length && !received.length) continue;
      result.push({
        sessionId:   row.session_id,
        nodeId:      row.node_id,
        excelPath:   row.excel_path || null,
        companyName: row.company_name || '',
        l2Name:      row.l2_name     || '',
        l3Name:      row.l3_name     || '',
        taskName:    row.task_name   || '',
        requests,
        waiting,
        received,
      });
    }
    return result;
  } catch (e) {
    console.error('[AuditService] getRequestItems error:', e.message);
    return [];
  }
}

// 특정 세션의 할 일 텍스트를 변경 (? → / 접두사 전환용)
function updateTodoText(sessionId, oldText, newText) {
  try {
    const db  = getDb();
    const row = db.prepare('SELECT todos FROM AuditSession WHERE id = ?').get(sessionId);
    if (!row) return false;
    const todos = JSON.parse(row.todos || '[]');
    const idx   = todos.findIndex(t => t.text === oldText);
    if (idx === -1) return false;
    todos[idx].text = _guardStr(newText, MAX_TODO_LEN) ?? '';
    db.prepare('UPDATE AuditSession SET todos = ?, last_active = ? WHERE id = ?')
      .run(_safeTodos(todos), _now(), sessionId);
    return true;
  } catch (e) {
    console.error('[AuditService] updateTodoText error:', e.message);
    return false;
  }
}

// 지정 노드 하위의 모든 active/pending 세션을 일괄 완료 처리
function completeAllSessionsUnder(nodeId) {
  try {
    const db = getDb();
    const n = _now();

    // BFS로 대상 노드 포함 전체 후손 노드 ID 수집
    const ids   = [nodeId];
    const queue = [nodeId];
    while (queue.length) {
      const parentId = queue.shift();
      const children = db.prepare('SELECT id FROM AuditNode WHERE parent_id = ?').all(parentId);
      for (const child of children) { ids.push(child.id); queue.push(child.id); }
    }

    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE AuditSession SET status = 'done', last_active = ?
       WHERE node_id IN (${placeholders}) AND status IN ('active', 'pending')`
    ).run(n, ...ids);
  } catch (e) {
    console.error('[AuditService] completeAllSessionsUnder error:', e.message);
  }
}

function deleteSession(sessionId) {
  try {
    getDb().prepare('DELETE FROM AuditSession WHERE id = ?').run(sessionId);
  } catch (e) {
    console.error('[AuditService] deleteSession error:', e.message);
  }
}

module.exports = {
  getChildren, getNode, addNode, updateNode, deleteNode,
  getNodePath, getAllL4Mappings,
  createSession, touchSession, saveSessionContent,
  moveSessionToPending, resumeSession, restoreToPending, completeSession,
  deleteSession,
  getSession, getPendingSessions, getDoneSessions,
  getOrCreateActiveSession, completeAllSessionsUnder,
  getRequestItems, updateTodoText,
  getAllNodes, getKanbanData,
  saveAuditSnapshotToDisk,
};
