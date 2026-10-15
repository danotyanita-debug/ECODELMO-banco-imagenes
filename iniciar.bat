@echo off
rem Inicia el servidor de monitoreo de obras (misma red WiFi)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto sinnode
echo Iniciando servidor... deja esta ventana abierta mientras uses la app.
echo Abre en el celular la direccion "Desde el celular" que aparece abajo.
echo.
call npm start
pause
exit /b 0
:sinnode
echo No se encontro Node.js. Instalalo desde https://nodejs.org y vuelve a ejecutar este archivo.
pause
exit /b 1
