@echo off
REM Creates or updates .env without Notepad's ".env.txt" trap.
cd /d "%~dp0"
setlocal enabledelayedexpansion

echo This writes your credentials to a local .env file.
echo It is git-ignored and never leaves this machine.
echo Press Enter to skip any value you do not have yet.
echo.

set /p SAMKEY="SAM.gov API key: "
set /p SAMURL="SAM.gov bulk CSV URL (optional): "

> .env echo # Local secrets. Git-ignored. Do not share this file.
if not "%SAMKEY%"=="" >> .env echo SAM_API_KEY=%SAMKEY%
if not "%SAMURL%"=="" >> .env echo SAM_BULK_CSV_URL=%SAMURL%

echo.
echo Wrote .env:
type .env
echo.
echo Now run:  node ingest/verify.mjs sam
pause
