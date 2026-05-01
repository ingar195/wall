@echo off
setlocal

cd /d "%~dp0"

REM Check Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Node.js is not installed.
    echo Download and install it from:
    echo   https://nodejs.org/en/download
    echo.
    start https://nodejs.org/en/download
    pause
    exit /b 1
)

REM Install dependencies if needed (or if copied from Linux)
if not exist "node_modules\electron\dist\electron.exe" (
    if exist "node_modules" (
        echo Removing incompatible node_modules...
        rd /s /q node_modules
    )
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed.
        pause
        exit /b 1
    )
)

REM Optional overrides
set WALL_SERVER=https://test.angry.fish
REM set WALL_KIOSK=0

echo Starting Wall Display...
node_modules\.bin\electron .
