@echo off
REM Double-click to build the search indexes locally, into data\index\.
REM SAM.gov needs a key: set it first with  set SAM_API_KEY=your-key-here
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org
  pause
  exit /b 1
)
echo Building indexes into data\index ...
echo.
node ingest/run.mjs
echo.
echo Done. Check the data\index folder and manifest.json.
pause
