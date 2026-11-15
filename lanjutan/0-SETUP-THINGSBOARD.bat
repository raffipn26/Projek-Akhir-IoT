@echo off
setlocal
title Setup ThingsBoard - absensi karyawan
rem LANJUTAN: biasanya cukup MULAI.bat di folder utama.
rem Login ke thingsboard.cloud lalu membuat / memperbarui device, atribut, rule chain, dashboard, customer HRD,
rem dan menyimpan token gateway ke rahasia.json. Password tidak disimpan.
rem Hanya memeriksa tanpa mengubah apa pun: 0-SETUP-THINGSBOARD.bat --uji
set "ROOT=%~dp0.."
cd /d "%ROOT%"
where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js belum terpasang. Pasang versi LTS dari https://nodejs.org lalu jalankan file ini lagi.
  pause
  exit /b 1
)
node "%ROOT%\tools\setup-thingsboard.js" %*
echo.
echo  Tekan tombol apa saja untuk menutup jendela ini . . .
pause >nul
