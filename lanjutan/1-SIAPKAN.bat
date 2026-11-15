@echo off
setlocal
title Siapkan WiFi dan sertifikat - absensi karyawan
rem LANJUTAN: biasanya cukup MULAI.bat di folder utama (menu L -> 6 untuk ganti WiFi / IP).
set "ROOT=%~dp0.."
cd /d "%ROOT%"
echo.
echo  ==== 1. Cek Node.js dan Node-RED ====
where node >nul 2>&1
if errorlevel 1 (
  echo  Node.js belum terpasang. Pasang versi LTS dari https://nodejs.org lalu jalankan file ini lagi.
  pause
  exit /b 1
)
where node-red >nul 2>&1
if errorlevel 1 (
  echo  Node-RED belum terpasang, memasang sekarang...
  call npm install -g --unsafe-perm node-red
)
echo.
echo  ==== 2. Memasang node tambahan (broker Aedes, node-forge) ====
pushd "%ROOT%\2-node-red\data"
call npm install --no-audit --no-fund
popd
echo.
echo  ==== 3. Isi data dan buat sertifikat ====
node "%ROOT%\tools\siapkan.js"
echo.
echo  Tekan tombol apa saja untuk menutup jendela ini . . .
pause >nul
