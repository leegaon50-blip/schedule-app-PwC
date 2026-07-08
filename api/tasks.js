'use strict';
// api/tasks.js — Vercel 서버리스 프록시: tasks.json GitHub 읽기/쓰기
// GITHUB_TOKEN / REPO_OWNER / REPO_NAME 은 Vercel Dashboard > Settings > Environment Variables 에서 설정
// (로컬 vercel dev 실행 시에는 프로젝트 루트 .env 파일을 자동으로 읽음)

const FILE = 'tasks.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.GITHUB_TOKEN;
  const OWNER = process.env.REPO_OWNER;
  const REPO  = process.env.REPO_NAME;
  if (!token || !OWNER || !REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN / REPO_OWNER / REPO_NAME 환경변수가 Vercel에 설정되지 않았습니다.' });
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
  const ghHeaders = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  // ── GET: tasks.json 읽기 ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    const r = await fetch(url, { headers: ghHeaders });
    const d = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json(d);
  }

  // ── PUT: tasks.json 쓰기 ──────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const r = await fetch(url, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(body),
    });
    const d = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json(d);
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
