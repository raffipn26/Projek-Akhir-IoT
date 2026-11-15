@echo off
setlocal
title MULAI - Absensi Karyawan e-KTP
cd /d "%~dp0"
rem Satu-satunya file yang perlu diklik: pemasangan pertama, pembaruan dari zip baru, dan pemakaian sehari-hari.
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Node.js belum terpasang.
  echo  Pasang versi LTS dari https://nodejs.org ^(halaman dibuka otomatis^), lalu klik MULAI.bat lagi.
  start "" https://nodejs.org
  echo.
  echo  Tekan tombol apa saja untuk menutup jendela ini . . .
  pause >nul
  exit /b 1
)
node "%~dp0tools\mulai.js" %*
echo.
echo  Tekan tombol apa saja untuk menutup jendela ini . . .
pause >nul
