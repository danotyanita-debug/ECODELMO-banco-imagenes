@echo off
rem Inicia el servidor y un tunel Cloudflare para usar la app con datos moviles
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto sinnode
where cloudflared >nul 2>nul
if errorlevel 1 goto sincf
set BEHIND_HTTPS=1
start "Servidor de obras" cmd /k "npm start"
timeout /t 3 >nul
echo.
echo Busca abajo la direccion https://....trycloudflare.com y abrela en Chrome del celular.
echo La direccion cambia cada vez que reinicias este archivo.
echo Deja abiertas esta ventana y la del servidor.
echo.
cloudflared tunnel --url http://localhost:3000
pause
exit /b 0
:sinnode
echo No se encontro Node.js. Instalalo desde https://nodejs.org y vuelve a ejecutar este archivo.
pause
exit /b 1
:sincf
echo No se encontro cloudflared. En PowerShell ejecuta: winget install Cloudflare.cloudflared
echo Luego cierra y vuelve a abrir este archivo.
pause
exit /b 1
