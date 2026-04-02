@echo off
pushd %~dp0
git --version > nul 2>&1
if %errorlevel% neq 0 (
    echo [91mGit is not installed on this system.[0m
    echo Install it from https://git-scm.com/downloads
    goto end
) else (
    if not exist .git (
        echo [91mNot running from a Git repository. Reinstall using an officially supported method to get updates.[0m
        echo See: https://docs.sillytavern.app/installation/windows/
        goto end
    )
    call git pull --rebase --autostash
    if %errorlevel% neq 0 (
        REM incase there is still something wrong
        echo [91mThere were errors while updating.[0m
        echo See the update FAQ at https://docs.sillytavern.app/installation/updating/
        goto end
    )
)
set NODE_ENV=production
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev
if %errorlevel% neq 0 (
    echo npm install failed.
    goto end
)

call npm run sync:extension
if %errorlevel% neq 0 (
    echo Failed to sync SillyTavern extension files.
    goto end
)

REM ---- Start TavernPlug bridge ----
set "TAVERNPLUG_DIR=%~dp0"
if exist "%TAVERNPLUG_DIR%\package.json" (
    start "TavernPlug Bridge" cmd /k "cd /d "%TAVERNPLUG_DIR%" && npm start"
) else (
    echo TavernPlug folder not found: %TAVERNPLUG_DIR%
)
:end
pause
popd
