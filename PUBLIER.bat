@echo off
rem Publie Gespo en ligne (a lancer une seule fois) : cree le depot public
rem "gespo" (le code seulement, les projets restent dans le depot prive gespo-data),
rem active GitHub Pages et envoie le code.
cd /d "%~dp0"
gh repo create hugomeunier98-creator/gespo --public --description "Gespo - gestionnaire de projets" --source . --remote origin
gh api -X POST repos/hugomeunier98-creator/gespo/pages -f build_type=workflow
git push -u origin master
echo.
echo Gespo sera en ligne dans 1 a 2 minutes : https://hugomeunier98-creator.github.io/gespo/
pause
