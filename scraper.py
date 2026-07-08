#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
KICPA 구인(수습CPA) 스크래퍼
사용: python scraper.py list | deadline <bltnNo> | stages <bltnNo>
"""
import re, json, sys, io, os

# Anaconda SSL DLL 경로 추가 (Windows: PATH 미설정 환경에서도 HTTPS 동작)
if sys.platform == 'win32' and hasattr(os, 'add_dll_directory'):
    _ssl_bin = os.path.join(os.path.expanduser('~'), 'anaconda3', 'Library', 'bin')
    if os.path.isdir(_ssl_bin):
        try:
            os.add_dll_directory(_ssl_bin)
        except Exception:
            pass

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, Exception):
    pass
import requests
from bs4 import BeautifulSoup

BASE       = "https://www.kicpa.or.kr"
LIST_URL   = BASE + "/home/jobOffrSrchNewGnrl/list.face"
DETAIL_URL = BASE + "/home/jobOffrSrchNewGnrl/detail.face"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": BASE,
}
# 수습CPA(ijJobSep=8) 전체 목록 기본 파라미터 (listCnt=50으로 누락 방지)
BASE_PARAMS = {
    "listCnt": "50", "page": "1", "srhType": "", "srhKey": "",
    "searchIjArea": "1800", "searchArea": "18",
    "ijCareer": "-1", "ijLastschool": "-1", "ijPay": "-1",
    "ijEmpSep": "all", "ijCoSep": "-1", "searchAreaBack": "00",
    "ijJobSep": "8", "ijIntId": "", "ijWname": "",
}


def to_iso(s):
    """YYYY.MM.DD / YYYY-MM-DD / YYYY/MM/DD → YYYY-MM-DD"""
    m = re.search(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", s or "")
    return f"{m.group(1)}-{m.group(2).zfill(2)}-{m.group(3).zfill(2)}" if m else None


# ── 목록 파싱 ───────────────────────────────────────────────────────────────
# <a class="subject_title" onclick="javascript:fn_detail('게시글ID')" href="#">
# → onclick 에서 bltnNo 추출, 번호/제목/회사명/등록일자 수집
def parse_list(html):
    soup = BeautifulSoup(html, "html.parser")
    jobs, seen = [], set()
    for row in soup.select("table.table_st02 tbody tr"):
        tds = row.find_all("td")
        if len(tds) < 7:
            continue
        a = row.select_one("td.subject a.subject_title")
        if not a:
            continue
        m = re.search(r"fn_detail\('(\d+)'\)", a.get("onclick", ""))
        if not m or m.group(1) in seen:
            continue
        seen.add(m.group(1))
        jobs.append({
            "id":      tds[0].get_text(strip=True),    # 목록 표시 번호 (21, 20…)
            "bltnNo":  m.group(1),                      # POST 파라미터 ijIdNum 값
            "title":   a.get_text(strip=True),
            "company": tds[2].get_text(strip=True),
            "date":    tds[6].get_text(strip=True),     # 등록일자 YYYY.MM.DD
        })
    return jobs


# ── 상세 페이지 마감일 파싱 ────────────────────────────────────────────────
# <th class="txt_l">마감일</th>
# <td class="txt_l">2026.06.30</td>   ← th 의 next sibling td
# 날짜로 파싱되지 않는 경우(미정, 모집 완료시 등)에도 raw 텍스트를 함께 반환
# ── 전형 단계 분류 패턴 (우선순위 순) ──────────────────────────────────────
_STAGE_PATTERNS = [
    (r'서류|접수|지원',   '서류 마감'),
    (r'인적성|필기|적성', '인적성'),
    (r'최종|2차|임원',    '최종 면접'),
    (r'1차',              '1차 면접'),
    (r'면접',             '면접'),
]
_STAGE_ORDER = ['서류 마감', '인적성', '1차 면접', '면접', '최종 면접']

def _classify_stage(text):
    for pattern, label in _STAGE_PATTERNS:
        if re.search(pattern, text):
            return label
    return None

def parse_stages(html):
    """상세 페이지에서 전형명+날짜 쌍 추출 → [{"stage":..,"date":..}, ...]"""
    soup = BeautifulSoup(html, "html.parser")
    found = {}  # label -> iso_date (선착 1개)

    # th/td 쌍 스캔
    for th in soup.find_all("th"):
        th_txt = th.get_text(strip=True)
        td = th.find_next_sibling("td")
        td_txt = td.get_text(" ", strip=True) if td else ""
        combined = th_txt + " " + td_txt
        label = _classify_stage(combined)
        if not label or label in found:
            continue
        dates = re.findall(r'\d{4}[.\-]\d{1,2}[.\-]\d{1,2}', combined)
        if dates:
            iso = to_iso(dates[-1])  # 범위면 마지막(마감) 날짜
            if iso:
                found[label] = iso

    # 줄 단위 전문 스캔 (th/td 미사용 텍스트 보완)
    for line in soup.get_text(separator='\n').split('\n'):
        line = line.strip()
        if not line:
            continue
        label = _classify_stage(line)
        if not label or label in found:
            continue
        dates = re.findall(r'\d{4}[.\-]\d{1,2}[.\-]\d{1,2}', line)
        if dates:
            iso = to_iso(dates[-1])
            if iso:
                found[label] = iso

    # 서류 마감이 없으면 parse_deadline으로 보완
    if '서류 마감' not in found:
        dl = parse_deadline(html)
        if dl.get('deadline'):
            found['서류 마감'] = dl['deadline']

    return [{"stage": s, "date": found[s]} for s in _STAGE_ORDER if s in found]


def parse_deadline(html):
    soup = BeautifulSoup(html, "html.parser")
    for th in soup.find_all("th"):
        if th.get_text(strip=True) == "마감일":
            td = th.find_next_sibling("td")
            if td:
                raw = td.get_text(strip=True)
                return {"deadline": to_iso(raw), "deadline_raw": raw}
    return {"deadline": None, "deadline_raw": None}


# ── HTTP 요청 ───────────────────────────────────────────────────────────────
def cmd_list(session):
    r = session.post(LIST_URL, data=BASE_PARAMS, timeout=15)
    r.encoding = "utf-8"
    return parse_list(r.text)


def cmd_deadline(session, bltn_no):
    params = {**BASE_PARAMS, "ijIdNum": bltn_no}
    r = session.post(DETAIL_URL, data=params, timeout=15)
    r.encoding = "utf-8"
    return parse_deadline(r.text)


def cmd_stages(session, bltn_no):
    params = {**BASE_PARAMS, "ijIdNum": bltn_no}
    r = session.post(DETAIL_URL, data=params, timeout=15)
    r.encoding = "utf-8"
    dl = parse_deadline(r.text)
    return {
        "stages":       parse_stages(r.text),
        "deadline":     dl.get("deadline"),
        "deadline_raw": dl.get("deadline_raw"),
    }


# ── 진입점 ──────────────────────────────────────────────────────────────────
def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""

    session = requests.Session()
    session.headers.update(HEADERS)
    try:
        session.get(BASE, timeout=10)   # 세션 쿠키 초기화
    except Exception:
        pass

    if cmd == "list":
        try:
            print(json.dumps(cmd_list(session), ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            sys.exit(1)

    elif cmd == "deadline" and len(sys.argv) > 2:
        try:
            result = cmd_deadline(session, sys.argv[2])
            print(json.dumps(result, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"deadline": None, "deadline_raw": None, "error": str(e)}))
            sys.exit(1)

    elif cmd == "stages" and len(sys.argv) > 2:
        try:
            result = cmd_stages(session, sys.argv[2])
            print(json.dumps(result, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"stages": [], "deadline": None, "deadline_raw": None, "error": str(e)}))
            sys.exit(1)

    else:
        print(json.dumps({"error": "usage: list | deadline <bltnNo> | stages <bltnNo>"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
