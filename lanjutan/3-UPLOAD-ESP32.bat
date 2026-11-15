@echo off
title Upload firmware ESP32 - absensi karyawan
rem LANJUTAN: biasanya cukup MULAI.bat di folder utama (menu L -> 3).
rem Compile + upload firmware ke ESP32 lalu buka Serial Monitor. Port bisa ditentukan: 3-UPLOAD-ESP32.bat COM5
set "ROOT=%~dp0.."
cd /d "%ROOT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\tools\upload-esp32.ps1" %1
echo.
echo  Tekan tombol apa saja untuk menutup jendela ini . . .
pause >nul
