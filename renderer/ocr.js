// renderer/ocr.js  —  에브리타임 시간표 이미지 → Gemini Vision API 파싱
//
// 환경 분기:
//   window.ENV.GEMINI_API_KEY 있음 → Gemini 직접 호출 (Electron 로컬)
//   없음                           → /api/analyze-timetable 서버리스 프록시 (Vercel)
'use strict';

const _GEMINI_MODEL   = 'gemini-3.5-flash';
const _GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${_GEMINI_MODEL}:generateContent`;
const _TIMEOUT_MS = 30000;

const _EVERYTIME_PROMPT = [
  '너는 에브리타임 시간표 스크린샷을 분석하는 엔진이다.',
  '이미지의 요일(X축)과 시간 타임슬롯(Y축)을 시각적으로 파악하여 각 강의 블록의 정보를 추출하라.',
  '수업 시작 시간은 에브리타임 표준 그리드(09:00, 10:30, 12:00, 13:30, 15:00, 16:30, 18:00, 19:30, 21:00)에',
  '맞게 스냅(보정)하여 판단하고, 단강(75분)/연강(165분) 여부를 고려해 종료 시간을 계산하라.',
  '4~6자리 숫자 패턴은 강의실로 분류하라.',
  '오직 아래의 JSON 배열 형태로만 응답하라.',
  '[{"course_name":"강의명","schedules":[{"day":"월","start_time":"10:30","end_time":"11:45","classroom":"12345"}]}]',
].join(' ');

/**
 * 에브리타임 스크린샷 → 강의 배열
 * @param {File} file
 * @returns {Promise<Array<{ course_name: string, schedules: Array<{day,start_time,end_time,classroom}> }>>}
 */
async function parseEverytimeImage(file) {
  const base64   = await _fileToBase64(file);
  const mimeType = file.type || 'image/jpeg';

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), _TIMEOUT_MS);

  let res;
  try {
    const apiKey = window.ENV?.GEMINI_API_KEY;

    if (apiKey) {
      // ── Electron 로컬: Gemini API 직접 호출 ───────────────────────────
      res = await fetch(`${_GEMINI_API_URL}?key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents: [{
            parts: [
              { text: _EVERYTIME_PROMPT },
              { inline_data: { mime_type: mimeType, data: base64 } },
            ],
          }],
          generationConfig: { temperature: 0 },
        }),
        signal: controller.signal,
      });
    } else {
      // ── Vercel 배포: 서버리스 프록시 호출 ─────────────────────────────
      res = await fetch('/api/analyze-timetable', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ imageBase64: base64, mimeType }),
        signal:  controller.signal,
      });
    }
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 429) throw new Error('ERR_RATE_LIMIT');

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    // 서버리스 프록시: { error: "문자열" }  /  Gemini 직접: { error: { message: "..." } }
    const errMsg = (typeof errBody?.error === 'string')
      ? errBody.error
      : (errBody?.error?.message ?? res.statusText);
    throw new Error(`[${res.status}] ${errMsg}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return _parseAiJson(text);
}

// ── 내부 유틸 ─────────────────────────────────────────────────────────────────

function _parseAiJson(text) {
  // 마크다운·설명문 등 노이즈 제거 — 첫 [ 부터 마지막 ] 까지만 추출
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('AI 응답에서 JSON 배열을 찾을 수 없습니다.\n' + text.slice(0, 300));
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error('AI 응답을 JSON으로 파싱하지 못했습니다.\n' + jsonMatch[0].slice(0, 300));
  }
  if (!Array.isArray(parsed)) {
    throw new Error('AI 응답이 배열 형태가 아닙니다.');
  }
  return parsed;
}

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
