# 일정 관리 앱 — Claude 참고 문서

## 앱 개요
KICPA 수습CPA 채용공고 자동 수집 + 개인 일정 관리 앱.
- **데스크탑**: Electron (`npm start` 또는 `run.bat` 더블클릭)
- **모바일/웹**: Vercel 배포 (GitHub push 시 자동 재배포)
- **데이터 동기화**: GitHub API로 `tasks.json` 읽기/쓰기 → 모바일↔데스크탑 실시간 연동

## 로컬 환경
- 프로젝트 경로: `C:\schedule-app`
- Node.js v26 (electron.exe 수동 설치 필요 → `run.bat` 첫 실행 시 자동 처리)
- Python: `C:\Users\leega\anaconda3\python.exe`
- GitHub 저장소: `leegaon50-blip/schedule-app-v2` (비공개)
- Git 경로: `C:\Users\leega\AppData\Local\GitHubDesktop\app-3.5.11\resources\app\git\cmd\git.exe`

## 자동화
- **로컬→GitHub 자동 푸시**: Windows 작업 스케줄러 `ScheduleAppAutoSync` — 3분마다 `auto_push.ps1` 실행
- **GitHub Actions** (`crawl.yml`): 30분마다 KICPA 크롤링 + 기한 하루 전 카카오 알림 (매일 KST 오전 8시)

## 파일 구조
```
index.html          — 전체 UI (달력/일정목록/진행률/채용공고 탭, 바닐라 JS)
main.js             — Electron 메인 프로세스 (IPC, Python 호출, 30분 자동 체크)
preload.js          — contextBridge (electronAPI 노출)
scraper.py          — KICPA 크롤러 (list/deadline/notify 커맨드)
kakao_notify.py     — 카카오톡 나에게 보내기 (REST API)
run_crawler.py      — GitHub Actions 진입점 (크롤링 + 채용공고 카톡 알림)
notify_deadlines.py — 기한 하루 전 일정 카톡 알림 (run_crawler.py에서 호출)
kicpa_jobs.json     — 채용공고 데이터 (GitHub Actions이 자동 업데이트)
tasks.json          — 일정 데이터 (앱이 GitHub API로 읽기/쓰기)
notify_state.json   — 알림 중복 방지용 날짜 기록
token.json          — 카카오 OAuth 토큰
auto_push.ps1       — 로컬 변경사항 자동 커밋·푸시 스크립트
run.bat             — Electron 앱 실행용 배치파일 (더블클릭으로 실행)
package.json        — Electron 프로젝트 설정 (electron ^42.3.0)
requirements.txt    — Python 의존성
.github/workflows/crawl.yml — GitHub Actions 워크플로우
```

## 핵심 데이터 구조

### tasks.json (일정)
```json
[{
  "id": 1,
  "name": "일정명",
  "date": "2026-06-10",
  "time": "09:00",          // 선택, 24시간 형식 (null 가능)
  "urgency": "high|mid|low|none",
  "track": "yes|no",        // 진행률 관리 여부 (기본: no)
  "memo": "메모",
  "progress": 0,            // 0~100
  "subs": [...],            // 무한 중첩 세부일정 (동일 구조)
  "memoLog": { "날짜": "내용" }
}]
```

### kicpa_jobs.json (채용공고)
```json
{
  "jobs": [{ "id": "21", "bltnNo": "1779...", "title": "...", "company": "...",
             "date": "2026.05.28", "deadline": "2026-06-30", "deadline_raw": "..." }],
  "seenIds": ["bltnNo1", ...],
  "lastChecked": "...",
  "jobsListUrl": null
}
```

## index.html 주요 로직
- **localStorage** `schedule_app_tasks`: 로컬 캐시
- **GitHub 동기화**: `loadFromGitHub()` (앱 시작 시), `saveToGitHub()` (저장 시마다)
  - GitHub가 비어있고 로컬에 데이터 있으면 → 로컬을 GitHub에 업로드
  - GitHub에 데이터 있으면 → GitHub 데이터로 덮어씀
- **달력**: 오늘 날짜 = 노란 배경(`#fffbe6`) + 주황 원(`#e8a000`), 현재 월 자동 표시
- **롱프레스** (700ms): 일정 삭제 / 채용공고 마감일 일정 추가
- **Electron 모드**: `window.electronAPI` 존재 여부로 구분
- **모바일** `@media (max-width: 768px)`: 달력 셀 62px, 이벤트 9px 강제 표시

## 완료된 기능 (재수정 금지)
- 마감일 예외처리: `deadline=null` 공고 → 날짜 직접 지정 모달
- 모바일 달력 이벤트 크기 축소 버그 수정
- 채용공고 한글 깨짐 수정 (scraper.py UTF-8 강제 출력)
- 모바일↔데스크탑 일정 동기화 (GitHub API)
- 진행률 관리 기본값: 관리 안 함

## 주의사항
- PAT 토큰은 `index.html` 내 `SYNC.token`에 저장됨 (비공개 저장소이므로 허용)
- `tasks.json`이 `[]`이고 로컬에 데이터 있으면 로컬 데이터를 GitHub에 올림 (덮어쓰기 방지)
- `auto_push.ps1`은 항상 `git pull --rebase` 후 push (tasks.json API 커밋 충돌 방지)
