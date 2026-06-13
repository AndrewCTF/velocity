@echo off
cd /d "%~dp0"
start "osint-api" cmd /k "cd apps\api && .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000"
timeout /t 1 >nul
start "osint-web" cmd /k "corepack pnpm --filter @osint/web dev"
timeout /t 8 >nul
start "" http://localhost:5173
