@echo off
setlocal EnableExtensions
REM ============================================================
REM Xinqing Portable - One-click start
REM Order: junctions -> PostgreSQL -> embed(8001) -> pyfeat(8002)
REM        -> Flask(6007) -> Next(6006)
REM Logs: app\logs\*.log   Keep this window open while using the app.
REM Run the init-database batch once before the first start.
REM ============================================================

set "ROOT=%~dp0.."
set "APP=%ROOT%\app"
set "LOG=%APP%\logs"
set "LINKROOT=%LOCALAPPDATA%\xinqing-pg"
set "PGBIN=%LINKROOT%\pg\bin"
set "PGDATA_LINK=%LINKROOT%\pgdata"
set "VENV_PY=%ROOT%\runtime\venv\Scripts\python.exe"
set "NODE_EXE=%ROOT%\runtime\node\node.exe"

REM ---- Offline env for bundled model services (inherited by child processes) ----
REM HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE: embed_service must never touch the network.
REM TORCH_HOME: py-feat gateway loads resnet18 backbone from models\pyfeat\torch_home
REM   (see README in models\pyfeat; without it Detector downloads resnet18).
set "HF_HUB_OFFLINE=1"
set "TRANSFORMERS_OFFLINE=1"
set "TORCH_HOME=%ROOT%\models\pyfeat\torch_home"
set "EMBED_MODEL_PATH=%ROOT%\models\bge-m3"

if not exist "%LOG%" mkdir "%LOG%"
if not exist "%VENV_PY%" (
    echo [ERR] runtime\venv not found. Wait for environment setup, then retry.
    pause & exit /b 1
)

echo [1/6] Prepare ASCII junction paths...
if not exist "%LINKROOT%" mkdir "%LINKROOT%"
if exist "%PGDATA_LINK%" rmdir "%PGDATA_LINK%"
if exist "%LINKROOT%\pg" rmdir "%LINKROOT%\pg"
if not exist "%ROOT%\data\pgdata" mkdir "%ROOT%\data\pgdata"
mklink /J "%LINKROOT%\pg" "%ROOT%\runtime\postgres" >nul
mklink /J "%PGDATA_LINK%" "%ROOT%\data\pgdata" >nul

echo [2/6] Start PostgreSQL...
if not exist "%ROOT%\data\pgdata\PG_VERSION" (
    echo [ERR] Database not initialized. Run the init-database batch first.
    pause & exit /b 1
)
"%PGBIN%\pg_ctl.exe" status -D "%PGDATA_LINK%" >nul 2>&1
if not errorlevel 1 (
    echo       PostgreSQL already running - skip
) else (
    "%PGBIN%\pg_ctl.exe" -D "%PGDATA_LINK%" -o "-p 5432" -l "%LOG%\pg.log" -w -t 60 start
    if errorlevel 1 goto :fail_pg
)

echo [3/6] Start embed service (BGE-M3 CPU, :8001)...
pushd "%APP%"
start "XQ-EMBED" /MIN cmd /c ""%VENV_PY%" embed_service.py >> "%LOG%\embed.log" 2>&1"
popd
call :wait_port 8001 300 embed-service
if errorlevel 1 echo       [WARN] embed not ready, RAG/AI features may degrade.

echo [4/6] Start py-feat gateway (:8002)...
pushd "%APP%"
start "XQ-GATEWAY" /MIN cmd /c ""%VENV_PY%" pyfeat_gateway.py >> "%LOG%\gateway.log" 2>&1"
popd
call :wait_port 8002 60 pyfeat-gateway
if errorlevel 1 echo       [WARN] gateway not ready, face analysis may degrade.

echo [5/6] Start Flask API (:6007)...
set "PORT=6007"
set "HOST=0.0.0.0"
set "UPLOAD_DIR=%APP%\uploads"
pushd "%APP%"
start "XQ-API" /MIN cmd /c ""%VENV_PY%" run_server.py >> "%LOG%\api.log" 2>&1"
popd
call :wait_port 6007 120 flask-api
if errorlevel 1 goto :fail_api

echo [6/6] Start web frontend (:6006)...
pushd "%APP%\web"
set "BACKEND_URL=http://127.0.0.1:6007"
start "XQ-WEB" /MIN cmd /c ""%NODE_EXE%" node_modules\next\dist\bin\next start -p 6006 >> "%LOG%\web.log" 2>&1"
popd
call :wait_port 6006 90 web-frontend
if errorlevel 1 goto :fail_web

echo.
echo ============================================================
echo  [OK] All services started.
echo      Open in browser:  http://localhost:6006
echo      LAN access:       http://YOUR-PC-IP:6006  (allow 6006 in firewall)
echo      Find local IP:    run  ipconfig  in a cmd window
echo      Keep this window open; use the stop-batch to shut down.
echo      Video analyze monitor log: %LOG%\gateway_monitor.log
echo      TIP: first video analyze loads model 30-60s. WAIT for it;
echo           do NOT restart services while an analyze request is running
echo           (that breaks the proxy and shows "analyze failed" in page).
echo ============================================================
pause
exit /b 0

:fail_pg
echo [ERR] PostgreSQL failed to start. See %LOG%\pg.log
goto :end_fail
:fail_api
echo [ERR] Flask API failed to start. See %LOG%\api.log
goto :end_fail
:fail_web
echo [ERR] Web frontend failed to start. See %LOG%\web.log
goto :end_fail
:end_fail
pause
exit /b 1

REM ---- port readiness probe: %1=port %2=timeout-sec %3=name ----
:wait_port
set "_I=0"
:wp_loop
"%VENV_PY%" -c "import socket,sys;s=socket.socket();s.settimeout(1);sys.exit(0 if s.connect_ex(('127.0.0.1',%1))==0 else 1)" 2>nul
if not errorlevel 1 (
    echo       [OK] %3 ready on :%1
    exit /b 0
)
set /a _I+=1
if %_I% geq %2 (
    echo       [ERR] %3 not ready on :%1 within %2s
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto wp_loop
