# Compile + upload firmware absensi ke ESP32, lalu (pilihan) buka Serial Monitor 115200.
# Dipanggil oleh MULAI.bat dan lanjutan\3-UPLOAD-ESP32.bat. Port dicari otomatis; bisa juga ditentukan: 3-UPLOAD-ESP32.bat COM5
# Board esp32 dan 4 library dipasang otomatis bila belum ada (butuh internet, sekali saja).
# Kode keluar: 0 = berhasil, 2 = ESP32 tidak tercolok, 1 = gagal lainnya.
param([string]$Port = "", [switch]$TanpaMonitor)

$sketch = Join-Path $PSScriptRoot "..\1-arduino\absensi_karyawan"
$fqbn = "esp32:esp32:esp32"   # ESP32 Dev Module
$urlEsp32 = "https://espressif.github.io/arduino-esp32/package_esp32_index.json"
$versiBoard = "esp32:esp32@3.3.11"
$library = @("MFRC522@1.4.12", "LiquidCrystal I2C@1.1.2", "MQTT@2.5.3", "ArduinoJson@7.4.3")

# arduino-cli: bawaan Arduino IDE 2 (dipasang untuk semua pengguna atau hanya untuk saya), atau yang ada di PATH
$bawaanIde = "resources\app\lib\backend\resources\arduino-cli.exe"
$kandidat = @((Join-Path $env:ProgramFiles "Arduino IDE\$bawaanIde"), (Join-Path $env:LOCALAPPDATA "Programs\Arduino IDE\$bawaanIde"))
$cli = $kandidat | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cli) {
  $c = Get-Command arduino-cli -ErrorAction SilentlyContinue
  if ($c) { $cli = $c.Source }
  else { Write-Host "Arduino IDE 2 belum terpasang. Pasang dari https://www.arduino.cc/en/software lalu klik MULAI.bat lagi." -ForegroundColor Red; exit 1 }
}

# secrets.h dan ca_cert.h dibuat oleh MULAI.bat
foreach ($f in "secrets.h", "ca_cert.h") {
  if (-not (Test-Path (Join-Path $sketch $f))) { Write-Host "$f belum ada. Klik MULAI.bat dulu." -ForegroundColor Red; exit 1 }
}

# Cari port ESP32 (chip USB CP210x / CH340 / CH9102)
if (-not $Port) {
  $dev = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match "\((COM\d+)\)" -and $_.Name -match "CP210|CH34|CH910|USB.*(Serial|UART)" } | Select-Object -First 1
  if ($dev -and $dev.Name -match "\((COM\d+)\)") { $Port = $Matches[1] }
}
if (-not $Port) { Write-Host "ESP32 tidak terdeteksi. Colokkan kabel USB ESP32 (cek driver CP210x / CH340), lalu jalankan lagi." -ForegroundColor Yellow; exit 2 }

# Board esp32 + library: pasang otomatis bila belum ada
$adaBoard = (& $cli core list 2>$null | Select-String -SimpleMatch "esp32:esp32")
if (-not $adaBoard) {
  Write-Host "=== Memasang board ESP32 ($versiBoard), sekali saja, bisa beberapa menit ===" -ForegroundColor Cyan
  & $cli core update-index --additional-urls $urlEsp32
  & $cli core install $versiBoard --additional-urls $urlEsp32
  if ($LASTEXITCODE -ne 0) { Write-Host "Gagal memasang board ESP32 (cek internet)." -ForegroundColor Red; exit 1 }
}
$daftarLib = (& $cli lib list 2>$null | Out-String)
$kurang = @($library | Where-Object { $daftarLib -notmatch ("(?m)^" + [regex]::Escape(($_ -split "@")[0]) + "\s") })
if ($kurang.Count -gt 0) {
  Write-Host "=== Memasang library: $($kurang -join ', ') ===" -ForegroundColor Cyan
  & $cli lib update-index
  & $cli lib install @kurang
  if ($LASTEXITCODE -ne 0) { Write-Host "Gagal memasang library (cek internet)." -ForegroundColor Red; exit 1 }
}

Write-Host "=== 1/3 COMPILE firmware ===" -ForegroundColor Cyan
& $cli compile --fqbn $fqbn $sketch
if ($LASTEXITCODE -ne 0) { Write-Host "Compile GAGAL." -ForegroundColor Red; exit 1 }

Write-Host "`n=== 2/3 UPLOAD ke $Port ===" -ForegroundColor Cyan
# Serial Monitor (arduino-cli) yang sedang memakai port ini ditutup dulu supaya upload tidak gagal
$monitor = Get-CimInstance Win32_Process -Filter "Name='arduino-cli.exe'" | Where-Object { $_.CommandLine -match "monitor" -and $_.CommandLine -match "\b$Port\b" }
if ($monitor) { $monitor | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Host "Serial Monitor $Port yang terbuka ditutup dulu (buka lagi lewat menu MULAI nomor 4)."; Start-Sleep -Seconds 1 }
& $cli upload --fqbn $fqbn -p $Port $sketch
if ($LASTEXITCODE -ne 0) { Write-Host "Upload GAGAL. Tutup Serial Monitor lain yang memakai $Port, atau tahan tombol BOOT saat 'Connecting...'." -ForegroundColor Red; exit 1 }
Write-Host "Upload berhasil." -ForegroundColor Green

if ($TanpaMonitor) { exit 0 }
Write-Host "`n=== 3/3 SERIAL MONITOR $Port (115200) - Ctrl+C untuk berhenti, ketik j + Enter untuk melihat jarak HC-SR04 ===" -ForegroundColor Cyan
& $cli monitor -p $Port -c baudrate=115200
