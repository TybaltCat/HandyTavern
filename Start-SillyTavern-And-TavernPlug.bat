@echo off
setlocal
pushd %~dp0

set "TAVERNPLUG_DIR=%~dp0"
set "SILLYTAVERN_DIR=%~1"

if not defined SILLYTAVERN_DIR if defined TAVERNPLUG_SILLYTAVERN_PATH set "SILLYTAVERN_DIR=%TAVERNPLUG_SILLYTAVERN_PATH%"
if not defined SILLYTAVERN_DIR if exist "%USERPROFILE%\Desktop\SillyTavern\package.json" set "SILLYTAVERN_DIR=%USERPROFILE%\Desktop\SillyTavern"
if not defined SILLYTAVERN_DIR if exist "%USERPROFILE%\Desktop\SillyTavern-main\SillyTavern\package.json" set "SILLYTAVERN_DIR=%USERPROFILE%\Desktop\SillyTavern-main\SillyTavern"
if not defined SILLYTAVERN_DIR if exist "%USERPROFILE%\Documents\SillyTavern\package.json" set "SILLYTAVERN_DIR=%USERPROFILE%\Documents\SillyTavern"
if not defined SILLYTAVERN_DIR if exist "C:\SillyTavern\package.json" set "SILLYTAVERN_DIR=C:\SillyTavern"

if not exist "%TAVERNPLUG_DIR%\package.json" (
    echo TavernPlug folder not found: %TAVERNPLUG_DIR%
    goto end
)

if not defined SILLYTAVERN_DIR (
    echo SillyTavern folder not configured.
    echo Pass the path as the first argument or set TAVERNPLUG_SILLYTAVERN_PATH.
    goto end
)

if not exist "%SILLYTAVERN_DIR%\package.json" (
    echo SillyTavern folder not found: %SILLYTAVERN_DIR%
    echo Pass the correct path as the first argument or set TAVERNPLUG_SILLYTAVERN_PATH.
    goto end
)

call npm run sync:extension
if %errorlevel% neq 0 (
    echo Failed to sync TavernPlug extension files.
    goto end
)

start "TavernPlug Bridge" cmd /k "cd /d "%TAVERNPLUG_DIR%" && npm start"
start "SillyTavern" cmd /k "cd /d "%SILLYTAVERN_DIR%" && npm start"

echo Started TavernPlug and SillyTavern in separate windows.

:end
popd
endlocal
