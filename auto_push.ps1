$git  = "C:\Users\leega\AppData\Local\GitHubDesktop\app-3.5.11\resources\app\git\cmd\git.exe"
$repo = "C:\schedule-app"
$log  = Join-Path $repo "auto_push.log"

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Add-Content -Path $log -Value $line
}

Set-Location $repo

# 0) 이미 rebase/merge가 진행 중이면 (예: 사람이 손으로 충돌 해결 중) 절대 건드리지 않고 즉시 종료
if ((Test-Path ".git\rebase-merge") -or (Test-Path ".git\rebase-apply") -or (Test-Path ".git\MERGE_HEAD")) {
    Write-Log "SKIP: rebase 또는 merge가 이미 진행 중입니다. 자동 실행을 건너뜁니다. 수동 확인 필요."
    exit 1
}

# 1) 변경사항 확인
$status = & $git status --porcelain
if (-not $status) {
    exit 0
}

# 2) 핵심 데이터 파일 명시적 스테이징
foreach ($f in @('tasks.json', 'kicpa_jobs.json')) {
    if (Test-Path (Join-Path $repo $f)) {
        & $git add $f
    }
}

& $git add -A

# 3) 커밋
$staged = & $git diff --cached --name-only
if ($staged) {
    & $git commit -m "auto sync $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
    if ($LASTEXITCODE -ne 0) {
        Write-Log "ERROR: git commit 실패 (exit $LASTEXITCODE). 자동 실행 중단."
        exit 1
    }
}

# 4) 원격 반영 - rebase 대신 merge 사용 (자동화 스크립트에서 rebase는 실패 시 detached HEAD로
#    조용히 멈추는 위험이 있어, 실패가 눈에 보이는 merge로 변경)
& $git fetch origin
if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: git fetch 실패 (exit $LASTEXITCODE). 자동 실행 중단."
    exit 1
}

& $git merge origin/main --no-edit
if ($LASTEXITCODE -ne 0) {
    # merge 충돌 등 실패 시, 사람이 열어봤을 때 헷갈리지 않도록 즉시 원상복구 후 중단
    Write-Log "ERROR: git merge 실패 (exit $LASTEXITCODE). merge --abort 후 자동 실행 중단. 수동 확인 필요."
    & $git merge --abort
    exit 1
}

# 5) push - 실패해도 로컬 커밋/merge 결과는 이미 안전하게 완료된 상태이므로 로그만 남김
& $git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Log "ERROR: git push 실패 (exit $LASTEXITCODE). 로컬 커밋은 보존됨. 다음 주기에 재시도되거나 수동 push 필요."
    exit 1
}

Write-Log "OK: auto sync 완료 및 push 성공."
