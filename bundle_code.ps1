# bundle_code.ps1 - Merge project source files into a single text file

$OutputFile = "C:\schedule-app\project_bundle.txt"
$Root = "C:\schedule-app"

$Files = @(
    "CLAUDE.md",
    "index.html",
    "main.js",
    "preload.js",
    "scraper.py",
    "run_crawler.py",
    "package.json",
    "vercel.json",
    "auto_push.ps1",
    "requirements.txt",
    ".github/workflows/crawl.yml",
    "renderer/app.js",
    "renderer/scheduleView.js",
    "renderer/auditView.js",
    "renderer/holidays.js",
    "renderer/ocr.js",
    "services/attendanceService.js",
    "services/auditService.js",
    "services/scheduleService.js",
    "api/tasks.js",
    "api/analyze-timetable.js",
    "api/audit-snapshot.js",
    "config.example.js"
)

$ExtToLang = @{
    ".md"   = "markdown"
    ".html" = "html"
    ".js"   = "javascript"
    ".py"   = "python"
    ".json" = "json"
    ".ps1"  = "powershell"
    ".yml"  = "yaml"
    ".bat"  = "batch"
}

$sb = New-Object System.Text.StringBuilder
$null = $sb.AppendLine("# Project Bundle - schedule-app-v2")
$null = $sb.AppendLine("# Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")
$null = $sb.AppendLine("")

$IncludedCount = 0
$SkippedCount  = 0

foreach ($RelPath in $Files) {
    $FullPath = Join-Path $Root ($RelPath -replace '/', '\')
    if (Test-Path $FullPath) {
        $Ext  = [System.IO.Path]::GetExtension($RelPath).ToLower()
        $Lang = if ($ExtToLang.ContainsKey($Ext)) { $ExtToLang[$Ext] } else { "" }

        $null = $sb.AppendLine("---")
        $null = $sb.AppendLine("")
        $null = $sb.AppendLine("### File: $RelPath")
        $null = $sb.AppendLine("")
        $null = $sb.AppendLine('```' + $Lang)
        $Content = [System.IO.File]::ReadAllText($FullPath, [System.Text.Encoding]::UTF8)
        $null = $sb.AppendLine($Content.TrimEnd())
        $null = $sb.AppendLine('```')
        $null = $sb.AppendLine("")

        $IncludedCount++
        Write-Host "  [OK] $RelPath" -ForegroundColor Green
    } else {
        Write-Host "  [SKIP] $RelPath" -ForegroundColor Yellow
        $SkippedCount++
    }
}

[System.IO.File]::WriteAllText($OutputFile, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))

$SizeKB = [Math]::Round((Get-Item $OutputFile).Length / 1024, 1)
Write-Host ""
Write-Host "Done: $OutputFile" -ForegroundColor Cyan
Write-Host "Included: $IncludedCount / Skipped: $SkippedCount" -ForegroundColor Cyan
Write-Host "Size: ${SizeKB} KB" -ForegroundColor Cyan
