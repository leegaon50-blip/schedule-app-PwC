#!/usr/bin/env python
# audit_monitor.py — 열려있는 Excel 창 감지 (main.js에서 stdin으로 JSON 전달)
#
# stdin JSON 포맷:
# {
#   "mappings": { "파일명.xlsx": nodeId, ... },
#   "exclude":  ["_전기", "_PY", "_prior", "_2024"]   ← 생략 가능 (기본 빈 리스트)
# }

import sys
import re
import json

# Windows에서 PYTHONIOENCODING 없이 실행될 경우를 대비해 명시적으로 재설정
# (PYTHONIOENCODING=utf-8 + PYTHONUTF8=1 이 전달되면 이 줄은 no-op)
sys.stdin.reconfigure(encoding='utf-8', errors='replace')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')


# ── 창 제목 분석 유틸 ─────────────────────────────────────────────────────────

def _extract_full_stem(title):
    """
    Excel 창 제목 → 파일명 stem (확장자·오피스 장식 완전 제거 후 소문자 반환).

    처리 예시:
      "삼성전자 감사보고서.xlsx - Excel"              →  "삼성전자 감사보고서"
      "파일명 [호환 모드] - Microsoft Excel"          →  "파일명"
      "파일명.xlsm [읽기 전용] - Excel"               →  "파일명"
      "[읽기 전용] 파일명.xlsx - Excel"               →  "파일명"
      "파일명.xlsx [제한된 보기] - Excel"             →  "파일명"
      "파일명.xlsx - 복사본 - Excel"                  →  "파일명"
      "파일명.xlsx [공유] - Excel"                    →  "파일명"
    """
    # ① 뒤쪽 " - [Microsoft] Excel" 제거
    cleaned = re.sub(
        r'\s*[-–]\s*(Microsoft\s+)?Excel\s*$', '', title, flags=re.IGNORECASE
    ).strip()

    # ② " - 복사본" / " - Copy(N)" 등 비-대괄호 오피스 복사본 접미사 제거
    #    (반복 적용: "파일 - 복사본 - 복사본" 케이스도 처리)
    cleaned = re.sub(
        r'\s*[-–]\s*(복사본|Copy\s*(?:\(\d+\))?)\s*$', '', cleaned,
        flags=re.IGNORECASE
    ).strip()

    # ③ [읽기 전용] [제한된 보기] [공유] [호환 모드] [그룹] 등 모든 대괄호 주석 제거
    #    위치 무관 (접두사·접미사 모두 처리)
    cleaned = re.sub(r'\s*\[[^\]]*\]\s*', ' ', cleaned).strip()

    # ④ 엑셀 확장자 제거 (.xlsx / .xlsm / .xlsb / .xls / .xlam)
    cleaned = re.sub(r'\.(xlsx?|xlsm|xlsb|xlam)\s*$', '', cleaned,
                     flags=re.IGNORECASE).strip()
    return cleaned.lower()


def _is_excluded(stem, title, exclude_keywords):
    """
    등록 파일명 stem 또는 창 제목에 제외 키워드가 포함되면 True.
    (대소문자 구분 없이 비교 — _PY 하나로 _py, _Py 모두 커버)
    """
    check_targets = [stem.lower(), title.lower()]
    for kw in exclude_keywords:
        kw_lc = kw.lower()
        if any(kw_lc in t for t in check_targets):
            return True
    return False


# ── pywin32 기반 창 스캐너 ────────────────────────────────────────────────────

try:
    import win32gui

    def scan(mappings, exclude_keywords):
        fg = win32gui.GetForegroundWindow()
        found = []

        # 디버그: 수집된 Excel 관련 창 제목 목록
        excel_titles_seen = []

        def _cb(hwnd, _):
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd)
            if not title:
                return

            # Excel 관련 창인지 간단 판별 (디버그용 수집)
            title_lc = title.lower()
            looks_like_excel = (
                'excel' in title_lc or
                re.search(r'\.(xlsx?|xlsm|xlsb)', title_lc) is not None
            )
            if looks_like_excel:
                excel_titles_seen.append(title)

            # 창 제목에서 파일명 stem 전체 추출 (다단어 파일명 지원)
            title_full_stem = _extract_full_stem(title)

            for basename, node_id in mappings.items():
                # 등록 파일명에서 확장자 제거 → stem
                stem = re.sub(r'\.(xlsx?|xlsm|xlsb|xlam)$', '', basename,
                              flags=re.IGNORECASE)

                # ① 전기 조서 제외 필터
                if _is_excluded(stem, title, exclude_keywords):
                    sys.stderr.write(
                        f'[Monitor] SKIP(excluded) stem={stem!r} kw matched in title={title!r}\n'
                    )
                    continue

                # ② 완전 일치: 등록 stem ↔ 창 제목 full stem (소문자)
                if stem.lower() != title_full_stem:
                    # 매칭 실패는 Excel 관련 창일 때만 로그 (노이즈 감소)
                    if looks_like_excel:
                        sys.stderr.write(
                            f'[Monitor] NO MATCH: registered={stem.lower()!r} '
                            f'vs title_stem={title_full_stem!r}\n'
                        )
                    continue

                # ③ 매칭 성공
                sys.stderr.write(
                    f'[Monitor] MATCH: stem={stem!r} hwnd={hwnd} title={title!r}\n'
                )
                try:
                    r = win32gui.GetWindowRect(hwnd)
                    found.append({
                        'hwnd':       hwnd,
                        'title':      title,
                        'rect':       [r[0], r[1], r[2], r[3]],
                        'node_id':    node_id,
                        'excel_path': basename,
                        'focused':    hwnd == fg,
                        'minimized':  bool(win32gui.IsIconic(hwnd)),
                    })
                except Exception as e:
                    sys.stderr.write(f'[Monitor] GetWindowRect error: {e}\n')
                return  # 한 창은 첫 번째 성공 매핑에만 대응

        win32gui.EnumWindows(_cb, None)

        # 스캔 요약 (항상 출력)
        sys.stderr.write(
            f'[Monitor] 등록 파일: {list(mappings.keys())} | '
            f'Excel 창: {excel_titles_seen} | '
            f'매칭: {len(found)}개\n'
        )
        sys.stderr.flush()
        return found

except ImportError:
    def scan(_mappings, _exclude_keywords):
        sys.stderr.write('[Monitor] pywin32 미설치 — win32gui 없음\n')
        sys.stderr.flush()
        return []   # pywin32 미설치 시 빈 배열 반환


# ── 진입점 ────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    raw = sys.stdin.read().strip()
    if not raw:
        print(json.dumps([]))
        sys.exit(0)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.stderr.write(f'[Monitor] JSON 파싱 오류: {e}\n')
        print(json.dumps([]))
        sys.exit(0)

    # 신규 포맷: {"mappings": {...}, "exclude": [...]}
    # 구 포맷 호환: 단순 dict → mappings로 처리, exclude 빈 리스트
    if isinstance(data, dict) and 'mappings' in data:
        mappings         = data.get('mappings', {})
        exclude_keywords = data.get('exclude', [])
    else:
        mappings         = data
        exclude_keywords = []

    print(json.dumps(scan(mappings, exclude_keywords), ensure_ascii=False))
