@echo off
rem Copie les donnees synchronisees (GitHub) dans data\projets.xlsx, pour les ouvrir dans Excel.
cd /d "%~dp0"
node scripts\github-data.js export
pause
