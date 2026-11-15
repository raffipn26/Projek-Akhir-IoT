@echo off
setlocal
title Node-RED absensi karyawan - JANGAN DITUTUP
rem Dipakai MULAI.bat untuk menyalakan Node-RED. Bisa juga diklik langsung.
set "ROOT=%~dp0.."
cd /d "%ROOT%"
if not exist "%ROOT%\rahasia.json" (
  echo  Belum dipasang. Klik MULAI.bat di folder utama dulu.
  pause
  exit /b 1
)
netstat -ano | findstr /r /c:":1882 .*LISTENING" >nul
if not errorlevel 1 (
  echo  Node-RED sudah berjalan di port 1882. Editor dibuka di browser.
  node "%ROOT%\tools\buka-editor.js"
  timeout /t 5 >nul
  exit /b 0
)
rem Editor dibuka otomatis (langsung masuk, tanpa password) begitu Node-RED siap
start "" /b node "%ROOT%\tools\buka-editor.js" >nul 2>&1
echo  ===============================================================
echo   Node-RED absensi sedang berjalan. JANGAN tutup jendela ini.
echo   Editor : terbuka sendiri di browser (langsung masuk)
echo   Menutup jendela ini = mematikan Node-RED.
echo  ===============================================================
echo.
node-red -u "%ROOT%\2-node-red\data"
pause
