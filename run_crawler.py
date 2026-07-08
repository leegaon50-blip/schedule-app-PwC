#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GitHub Actions 에서 실행되는 KICPA 크롤러 진입점
로컬에서 직접 테스트: python run_crawler.py
"""

import sys
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, Exception):
    pass

import json
import os
import datetime
import requests

from scraper import cmd_list, BASE, HEADERS

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kicpa_jobs.json")


def load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"jobs": [], "seenIds": [], "pendingJobs": [], "lastJobNotifiedAt": ""}


def save_state(jobs: list, seen_ids: set, pending_jobs: list, last_notified_at: str) -> None:
    now_kst = datetime.datetime.utcnow() + datetime.timedelta(hours=9)
    state = {
        "jobs":              jobs,
        "seenIds":           list(seen_ids),
        "pendingJobs":       pending_jobs,
        "lastJobNotifiedAt": last_notified_at,
        "lastChecked":       now_kst.strftime("%Y-%m-%d %H:%M KST"),
        "jobsListUrl":       None,
    }
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


# ══════════════════════════════════════════════════════════════════════════════
# [로직 1] 스크랩 & DB 저장 ─ 시간 조건 없음, 호출될 때마다 항상 실행
# ══════════════════════════════════════════════════════════════════════════════
def scrape_and_update(now_kst: datetime.datetime) -> dict:
    """
    KICPA 사이트 현재 공고를 긁어 kicpa_jobs.json 에 저장(Upsert)한다.
    알림 시간(lastJobNotifiedAt / is_notify_hour)과 완전히 무관하게 항상 실행된다.
    반환값을 notify_if_due() 에 그대로 넘겨 파일 재읽기 없이 사용한다.
    """
    session = requests.Session()
    session.headers.update(HEADERS)
    try:
        session.get(BASE, timeout=10)
    except Exception:
        pass

    jobs = cmd_list(session)
    print(f"  → 현재 공고 {len(jobs)}건 수집")

    prev             = load_state()
    seen_ids         = set(prev.get("seenIds", []))
    pending_jobs     = list(prev.get("pendingJobs", []))
    last_notified_at = prev.get("lastJobNotifiedAt", "")

    print(f"  → [스크랩] 이전 seenIds: {len(seen_ids)}건 / pendingJobs: {len(pending_jobs)}건 / lastJobNotifiedAt: {last_notified_at!r}")
    pending_bltnNos  = {j.get("bltnNo") for j in pending_jobs if j.get("bltnNo")}
    bltn_ids_in_seen = {x for x in seen_ids if len(x) > 5}
    is_first         = len(bltn_ids_in_seen) == 0

    new_jobs = []
    for j in jobs:
        bn = j.get("bltnNo")
        if not bn:
            continue
        if bn not in seen_ids:
            if not is_first and bn not in pending_bltnNos:
                new_jobs.append({**j, "discoveredAt": now_kst.isoformat()})
            seen_ids.add(bn)

    if is_first:
        print(f"  → 초기 실행: 공고 {len(jobs)}건 seenIds 초기화 (알림 없음)")
    elif new_jobs:
        print(f"  → 신규 공고 {len(new_jobs)}건 발견 → pendingJobs 누적")
        pending_jobs.extend(new_jobs)
    else:
        print("  → 신규 공고 없음")

    save_state(jobs, seen_ids, pending_jobs, last_notified_at)

    return {
        "jobs":             jobs,
        "seen_ids":         seen_ids,          # set
        "pending_jobs":     pending_jobs,      # 이번 실행에서 추가된 new_jobs 포함
        "last_notified_at": last_notified_at,  # 디스크에서 읽어온 값 (변경 없음)
    }



def main():
    now_kst = datetime.datetime.utcnow() + datetime.timedelta(hours=9)
    print(f"[{now_kst:%Y-%m-%d %H:%M} KST] KICPA 크롤러 시작")

    # ── 1. 스크랩 & DB 저장 (시간 조건 없이 항상 실행)
    try:
        state = scrape_and_update(now_kst)
    except Exception as e:
        print(f"  ❌ 스크랩 실패: {e}")
        return

    print("  완료")


if __name__ == "__main__":
    main()
