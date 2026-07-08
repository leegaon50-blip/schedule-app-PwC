@echo off
set "EXE=C:\schedule-app\node_modules\electron\dist\electron.exe"
set "APP=C:\schedule-app"

if exist "%EXE%" goto launch

echo Downloading Electron v42.3.0 (first time only, please wait)...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/electron/electron/releases/download/v42.3.0/electron-v42.3.0-win32-x64.zip' -OutFile '%TEMP%\electron.zip' -UseBasicParsing; Expand-Archive -Path '%TEMP%\electron.zip' -DestinationPath 'C:\schedule-app\node_modules\electron\dist' -Force"
if not exist "%EXE%" (
    echo FAILED. Check your internet connection and try again.
    pause
    exit /b 1
)
echo electron.exe> "C:\schedule-app\node_modules\electron\dist\path.txt"
echo Done!

:launch
cd /d "%APP%"
"%EXE%" .
