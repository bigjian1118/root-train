@echo off
setlocal EnableExtensions
REM ============================================================
REM Xinqing Portable - Stop all services
REM Graceful order: app processes first, then PostgreSQL (fast shutdown).
REM Safe to run even if nothing is running.
REM ============================================================

set "ROOT=%~dp0.."
set "LINKROOT=%LOCALAPPDATA%\xinqing-pg"
set "PGBIN=%LINKROOT%\pg\bin"
set "PGDATA_LINK=%LINKROOT%\pgdata"

echo [1/2] Stop app services (embed 8001 / gateway 8002 / api 6007 / web 6006)...
taskkill /FI "WINDOWTITLE eq XQ-*" /T /F >nul 2>&1
echo       done.

echo [2/2] Stop PostgreSQL (graceful)...
if exist "%PGBIN%\pg_ctl.exe" (
    "%PGBIN%\pg_ctl.exe" -D "%PGDATA_LINK%" stop -m fast
) else (
    echo       pg_ctl not found - nothing to stop.
)

echo.
echo ============================================================
echo  [WARN] Check all services are stopped before ejecting the disk.
echo ============================================================
pause
exit /b 0
