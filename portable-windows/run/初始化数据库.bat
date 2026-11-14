@echo off
setlocal EnableExtensions
REM ============================================================
REM Xinqing Portable - Database initialization (run ONCE before first start)
REM
REM Why junctions: initdb fails when the data path contains non-ASCII
REM characters (PostgreSQL GBK leak, confirmed on this project). We create
REM ASCII junctions under %LOCALAPPDATA% and run everything through them:
REM   %LOCALAPPDATA%\xinqing-pg\pg     -> <root>\runtime\postgres
REM   %LOCALAPPDATA%\xinqing-pg\pgdata -> <root>\data\pgdata
REM
REM Steps: junctions -> initdb -> temp server -> createdb psy ->
REM        CREATE EXTENSION vector -> tables + builtin article seed -> stop
REM Requires: runtime\postgres and runtime\venv (Flask deps installed).
REM ============================================================

set "ROOT=%~dp0.."
set "LINKROOT=%LOCALAPPDATA%\xinqing-pg"
set "PGBIN=%LINKROOT%\pg\bin"
set "PGDATA_LINK=%LINKROOT%\pgdata"
set "PGDATA_REAL=%ROOT%\data\pgdata"
set "VENV_PY=%ROOT%\runtime\venv\Scripts\python.exe"

echo [1/7] Prepare ASCII junction paths...
if exist "%PGDATA_LINK%" rmdir "%PGDATA_LINK%"
if exist "%LINKROOT%\pg" rmdir "%LINKROOT%\pg"
if not exist "%LINKROOT%" mkdir "%LINKROOT%"
if not exist "%PGDATA_REAL%" mkdir "%PGDATA_REAL%"
mklink /J "%LINKROOT%\pg" "%ROOT%\runtime\postgres" >nul
if errorlevel 1 goto :fail_junction
mklink /J "%PGDATA_LINK%" "%PGDATA_REAL%" >nul
if errorlevel 1 goto :fail_junction

echo [2/7] initdb (UTF8, superuser=psy, scram-sha-256)...
if exist "%PGDATA_REAL%\PG_VERSION" (
    echo       data directory already initialized - skip initdb
) else (
    echo psy>"%LINKROOT%\pw.txt"
    "%PGBIN%\initdb.exe" -D "%PGDATA_LINK%" -U psy -E UTF8 -A scram-sha-256 --pwfile="%LINKROOT%\pw.txt" --locale=C
    if errorlevel 1 goto :fail_initdb
    del "%LINKROOT%\pw.txt"
)

echo [3/7] Start temporary PostgreSQL...
set "PGPASSWORD=psy"
"%PGBIN%\pg_ctl.exe" -D "%PGDATA_LINK%" -o "-p 5432" -l "%LINKROOT%\init_pg.log" -w -t 60 start
if errorlevel 1 goto :fail_start

echo [4/7] Create database psy...
"%PGBIN%\psql.exe" -h 127.0.0.1 -U psy -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='psy'" | findstr /C:1 >nul
if errorlevel 1 (
    "%PGBIN%\createdb.exe" -h 127.0.0.1 -U psy -O psy psy
    if errorlevel 1 goto :fail_createdb
) else (
    echo       database psy already exists - skip
)

echo [5/7] Enable pgvector extension...
"%PGBIN%\psql.exe" -h 127.0.0.1 -U psy -d psy -c "CREATE EXTENSION IF NOT EXISTS vector;"
if errorlevel 1 goto :fail_ext

echo [6/7] Create tables and seed builtin articles (via Flask app init)...
if not exist "%VENV_PY%" goto :fail_venv
pushd "%ROOT%\app"
"%VENV_PY%" -c "import run_server; print('[OK] schema + seed done')"
set "INIT_RC=%ERRORLEVEL%"
popd
if not "%INIT_RC%"=="0" goto :fail_seed

echo [7/7] Verify and stop temporary server...
"%PGBIN%\psql.exe" -h 127.0.0.1 -U psy -d psy -c "SELECT extname FROM pg_extension WHERE extname='vector';"
"%PGBIN%\psql.exe" -h 127.0.0.1 -U psy -d psy -c "\dt"
"%PGBIN%\pg_ctl.exe" -D "%PGDATA_LINK%" stop -m fast
if errorlevel 1 goto :fail_stop

echo.
echo ============================================================
echo  [OK] Database initialized. Now run the start-batch in this folder.
echo ============================================================
pause
exit /b 0

:fail_junction
echo [ERR] mklink failed. Check %LOCALAPPDATA% permissions.
goto :end_fail
:fail_initdb
echo [ERR] initdb failed. See output above.
goto :end_fail
:fail_start
echo [ERR] pg_ctl start failed. Log: %LINKROOT%\init_pg.log
goto :end_fail
:fail_createdb
echo [ERR] createdb failed.
goto :end_fail
:fail_ext
echo [ERR] CREATE EXTENSION vector failed. Is pgvector installed in runtime\postgres?
goto :end_fail
:fail_venv
echo [ERR] venv python not found: %VENV_PY%
echo       Wait until runtime\venv dependencies are installed, then rerun.
goto :end_fail
:fail_seed
echo [ERR] Table creation failed (Flask init-db). Check venv packages / DATABASE_URL.
goto :end_fail
:fail_stop
echo [ERR] pg_ctl stop failed. Run: "%PGBIN%\pg_ctl.exe" -D "%PGDATA_LINK%" stop -m fast
goto :end_fail
:end_fail
REM best-effort: never leave the temporary server running after a failure
"%PGBIN%\pg_ctl.exe" -D "%PGDATA_LINK%" stop -m fast >nul 2>&1
echo.
echo [FAIL] Initialization NOT complete. Fix the error above and rerun this script.
pause
exit /b 1
