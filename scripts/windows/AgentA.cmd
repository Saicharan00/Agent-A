@echo off
rem Agent A launcher for Windows. Double-click it (or pin a shortcut to it).
rem Starts the "agent-a" Docker Sandbox if needed, runs `pnpm launch` inside it in a new window,
rem then opens http://localhost:3000 once the app answers. The app itself only ever runs inside the sandbox.
rem Port 3000 reaches the sandbox because it was created with `-p 127.0.0.1:3000:3000` and .env.local sets
rem AGENTA_WEB_HOST=0.0.0.0 (see README "Opening the app from Windows").
setlocal
set SANDBOX=agent-a
set WORKDIR=/e/Agent-A-GrokBot
set URL=http://localhost:3000

where sbx >nul 2>nul || (echo sbx was not found. Install Docker Sandboxes: winget install Docker.sbx & pause & exit /b 1)

curl.exe -s -o nul -f %URL%/api/health && goto open

rem `sbx exec` starts a stopped sandbox first. Closing that window (or Ctrl+C in it) stops the app.
start "Agent A" sbx exec -it -w %WORKDIR% %SANDBOX% bash -lc "pnpm launch"

echo Waiting for Agent A to start (the first launch builds the app and can take a few minutes)...
set /a tries=0
:wait
timeout /t 3 /nobreak >nul
curl.exe -s -o nul -f %URL%/api/health && goto open
set /a tries+=1
if %tries% lss 200 goto wait
echo Agent A did not answer at %URL% after 10 minutes. Check the "Agent A" window for errors.
pause
exit /b 1

:open
start "" %URL%
exit /b 0
