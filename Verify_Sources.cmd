@echo off
REM Double-click to check which tender portals respond. Writes nothing, changes nothing.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed, or not on your PATH.
  echo Install the LTS version from https://nodejs.org  then run this again.
  echo.
  pause
  exit /b 1
)
echo Node version:
node --version
echo.
echo Checking every tender source. This takes under a minute...
echo.
node ingest/verify.mjs
echo.
echo Copy the SUMMARY block above if you need help with a failure.
pause
