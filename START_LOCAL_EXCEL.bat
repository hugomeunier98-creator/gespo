@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installation des dependances npm...
  call npm install
  if errorlevel 1 (
    echo Erreur lors de l'installation des dependances.
    pause
    exit /b 1
  )
)

start "Gespo - serveur" node server.js
ping -n 3 127.0.0.1 >nul
start "" "http://localhost:4173"

endlocal
