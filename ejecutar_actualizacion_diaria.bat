@echo off
SETLOCAL EnableDelayedExpansion
SET NODE_TLS_REJECT_UNAUTHORIZED=0
cd /d "C:\Users\Pc\Desktop\Proyectista-SCBA"
if not exist "logs" mkdir "logs"
echo [%DATE% %TIME%] Iniciando tarea programada de actualizacion diaria SCBA >> "logs\scheduler.log"
node "C:\Users\Pc\Desktop\Proyectista-SCBA\actualizador_diario_scba.js" >> "logs\scheduler.log" 2>&1
echo [%DATE% %TIME%] Tarea finalizada con codigo %ERRORLEVEL% >> "logs\scheduler.log"
ENDLOCAL
