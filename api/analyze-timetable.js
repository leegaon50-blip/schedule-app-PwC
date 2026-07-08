// api/analyze-timetable.js  —  Vercel 서버리스 Gemini Vision 프록시
// GEMINI_API_KEY 는 Vercel Dashboard > Settings > Environment Variables 에서 설정
'use strict';

const GEMINI_MODEL   = 'gemini-3.5-flash';
const GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROMPT = [
  '너는 에브리타임 시간표 스크린샷을 분석하는 엔진이다.',
  '이미지의 요일(X축)과 시간 타임슬롯(Y축)을 시각적으로 파악하여 각 강의 블록의 정보를 추출하라.',
  '수업 시작 시간은 에브리타임 표준 그리드(09:00, 10:30, 12:00, 13:30, 15:00, 16:30, 18:00, 19:30, 21:00)에',
  '맞게 스냅(보정)하여 판단하고, 단강(75분)/연강(165분) 여부를 고려해 종료 시간을 계산하라.',
  '4~6자리 숫자 패턴은 강의실로 분류하라.',
  '오직 아래의 JSON 배열 형태로만 응답하라.',
  '[{"course_name":"강의명","schedules":[{"day":"월","start_time":"10:30","end_time":"11:45","classroom":"12345"}]}]',
].join(' ');

module.exports = async function handler(req, res) {
  // CORS — 같은 Vercel 도메인에서 호출하므로 실질적으로 불필요하나 안전망으로 포함
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 환경변수 확인
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY가 서버에 설정되지 않았습니다. Vercel Dashboard > Settings > Environment Variables를 확인해 주세요.',
    });
  }

  // 바디 파싱 확인
  const body = req.body ?? {};
  const { imageBase64, mimeType } = body;
  if (!imageBase64 || !mimeType) {
    return res.status(400).json({
      error: `필수 필드 누락 — imageBase64: ${!!imageBase64}, mimeType: ${!!mimeType}`,
    });
  }

  const payload = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: { temperature: 0 },
  };

  // Gemini API 호출 — fetch 실패(DNS, 네트워크)도 잡아서 502 반환
  let geminiRes;
  try {
    geminiRes = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch (fetchErr) {
    return res.status(502).json({ error: '외부 API(Gemini) 호출 실패: ' + fetchErr.message });
  }

  const data = await geminiRes.json().catch(() => ({}));
  return res.status(geminiRes.status).json(data);
};
