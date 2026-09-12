@echo off
setlocal
if not exist dist\server\server\index.js (
  echo QA Agent is not built. Run install-windows.bat first.
  pause
  exit /b 1
)
if not exist .env (
  echo .env is missing. Copy .env.example to .env and configure Supabase first.
  pause
  exit /b 1
)
start "QA Agent Browser" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:4782"
call npm start
