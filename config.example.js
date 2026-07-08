// config.example.js — 이 파일을 복사해 config.js 로 저장한 뒤 키를 입력하세요.
//
// · config.js 는 .gitignore 에 등록되어 GitHub에 올라가지 않습니다.
// · Electron 로컬 실행 시에는 이 파일(config.js)에서 키를 읽습니다.
// · Vercel 배포 시에는 이 파일이 없어도 됩니다.
//   대신 Vercel Dashboard > Project > Settings > Environment Variables 에서
//   GEMINI_API_KEY / GITHUB_TOKEN / REPO_OWNER / REPO_NAME 을 추가하면
//   /api/* 서버리스 함수가 자동으로 사용합니다.

window.ENV = {
  GEMINI_API_KEY: '',   // ← Google AI Studio(aistudio.google.com)에서 발급한 API 키
  GITHUB_TOKEN:   '',   // ← GitHub Settings > Developer settings > Personal access tokens 에서 발급 (repo 쓰기 권한)
  REPO_OWNER:     '',   // ← GitHub 사용자명/조직명
  REPO_NAME:      '',   // ← 이 프로젝트를 올린 저장소 이름
};
