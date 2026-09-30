@echo off
REM Commits the freshly built search indexes and pushes them, so Netlify serves them.
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo Git is not installed, or not on your PATH.
  echo Install it from https://git-scm.com/download/win then run this again.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo.
  echo This folder is not a git repository.
  echo You are probably working in the extracted zip rather than your cloned repo.
  echo Copy these files into your cloned repo folder, then run this there.
  echo.
  pause
  exit /b 1
)

if not exist "data\index\manifest.json" (
  echo.
  echo No manifest.json found in data\index.
  echo Run Run_Ingest.cmd first to build the indexes.
  echo.
  pause
  exit /b 1
)

echo Index files to be committed:
dir /b data\index\*.json
echo.

git add data/index
git diff --staged --quiet
if not errorlevel 1 (
  echo No changes to commit - the indexes are already up to date.
  pause
  exit /b 0
)

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set STAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%
git commit -m "Refresh tender indexes (%STAMP%)"
if errorlevel 1 (
  echo.
  echo Commit failed. If git asks for your name/email, run these once:
  echo   git config --global user.name "Your Name"
  echo   git config --global user.email "you@example.com"
  pause
  exit /b 1
)

echo.
echo Pushing...
git push
if errorlevel 1 (
  echo.
  echo Push failed. Check that you are signed in to GitHub and on the right branch.
  pause
  exit /b 1
)

echo.
echo Done. Netlify will redeploy in a minute or two, then the cached sources go live.
pause
