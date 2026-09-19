@echo off
setlocal
cd /d "%~dp0"

set "NODE="
for %%I in (node.exe) do if not defined NODE set "NODE=%%~$PATH:I"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE (
  echo Node.js not found. Install Node 22+ from https://nodejs.org
  echo or add the folder containing node.exe to PATH.
  pause
  exit /b 1
)

"%NODE%" --env-file-if-exists=.env server\live-server.mjs
