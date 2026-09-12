@echo off
setlocal enabledelayedexpansion
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20 or newer is required.
  echo Install the current Node.js LTS release, then run this file again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js 20 or newer is required. Current major: %NODE_MAJOR%
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul

echo [1/4] Installing QA Agent dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 goto :fail

echo [2/4] Installing Chromium for UI QA...
call npm run install:browser
if errorlevel 1 goto :fail

echo [3/4] Building QA Agent...
call npm run build
if errorlevel 1 goto :fail

echo [4/4] Running release self-test...
call npm run selftest
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo QA Agent V2 installed and self-tested successfully.
echo Next: open .env and add your Supabase values.
echo Gemini is optional; add GEMINI_API_KEY only if you want
 echo natural-language requirement conversion.
echo Then double-click start-windows.bat.
echo ============================================================
pause
exit /b 0

:fail
echo.
echo [ERROR] Installation or verification failed. Do not use this build for a client demo.
pause
exit /b 1
