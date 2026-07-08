// api/audit-snapshot.js — Vercel 서버리스 GitHub 프록시
// GITHUB_TOKEN / REPO_OWNER / REPO_NAME 은 Vercel Dashboard > Settings > Environment Variables 에서 설정
// 브라우저에 토큰을 노출하지 않고 private 레포의 audit_snapshot.json을 안전하게 반환
'use strict';

const FILE = 'audit_snapshot.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' });

  const token = process.env.GITHUB_TOKEN;
  const OWNER = process.env.REPO_OWNER;
  const REPO  = process.env.REPO_NAME;
  if (!token || !OWNER || !REPO) {
    return res.status(500).json({
      error: 'GITHUB_TOKEN / REPO_OWNER / REPO_NAME 환경변수가 Vercel에 설정되지 않았습니다.',
      hint:  'Vercel Dashboard › 프로젝트 선택 › Settings › Environment Variables 에서 추가하세요.',
    });
  }

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!r.ok) {
      const body = await r.json().catch(() => ({ message: r.statusText }));
      return res.status(r.status).json({
        error: `GitHub API ${r.status} — ${body.message || r.statusText}`,
        url,
      });
    }

    const d        = await r.json();
    const snapshot = JSON.parse(
      decodeURIComponent(escape(atob(d.content.replace(/\n/g, ''))))
    );

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(snapshot);
  } catch (e) {
    return res.status(500).json({ error: `서버 오류: ${e.message}`, url });
  }
};
