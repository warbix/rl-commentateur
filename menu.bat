@echo off
rem Double-click: a menu with the commands of the commentator
cd /d "%~dp0"

set "empty=0"

:menu
echo.
echo  Commentateur Rocket League
echo  ---------------------------
echo  1. Lancer le bot
echo  2. Lancer le bot + la page des voix (dans une autre fenetre)
echo  3. Page des voix seule (ecouter, tester une phrase)
echo  4. Generer les voix manquantes (et supprimer les inutiles)
echo  5. Calibrer les seuils avec les votes
echo  6. Verifier l'API de Rocket League
echo  7. Lancer les tests
echo  Q. Quitter
echo.
set "choice="
set /p "choice=Choix : "
rem Nothing typed three times in a row (or no keyboard): quit instead of looping
if not defined choice (set /a empty+=1) else (set "empty=0")
if %empty% geq 3 exit /b

if "%choice%"=="1" call npm start <nul & goto menu
if "%choice%"=="2" start "Page des voix" cmd /k npm run library & call npm start <nul & goto menu
if "%choice%"=="3" call npm run library <nul & goto menu
if "%choice%"=="4" call npm run pregenerate -- --prune <nul & goto menu
if "%choice%"=="5" call npm run calibrate <nul & goto menu
if "%choice%"=="6" call npm run check-api <nul & goto menu
if "%choice%"=="7" call npm test <nul & goto menu
if /i "%choice%"=="q" exit /b
goto menu
