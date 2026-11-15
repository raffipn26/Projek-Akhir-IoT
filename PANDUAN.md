# Panduan Menjalankan Absensi Karyawan e-KTP

## Cara pakai (cukup ini)

**Siapkan sekali saja:** [Node.js LTS](https://nodejs.org), [Arduino IDE 2](https://www.arduino.cc/en/software), Google Chrome atau Microsoft Edge, driver USB ESP32 (CP210x / CH340), dan akun https://thingsboard.cloud (boleh daftar pakai Google).

1. Colokkan ESP32 ke laptop.
2. Klik dua kali **`MULAI.bat`**.
3. Ikuti layar:
   - **Pertama kali:** login ThingsBoard di jendela browser yang terbuka (klik tombol Google), lalu ketik password WiFi. Nama WiFi dan IP laptop sudah terisi otomatis, cukup Enter. Board ESP32 & library Arduino dipasang otomatis.
   - **Berikutnya:** cukup tekan **ENTER**.

Hasilnya: ThingsBoard terisi, firmware ter-upload ke ESP32, dan Node-RED menyala di jendela sendiri bernama *Node-RED absensi* (**jangan ditutup**; menutupnya = mematikan Node-RED).

**Ada zip versi baru?** Ekstrak menimpa folder lama (*Replace the files*), klik **`MULAI.bat`**, tekan **ENTER**. Hanya bagian yang berubah yang diperbarui. Daftar karyawan, jadwal, WiFi, token, sertifikat, dan rekap absen **tidak pernah ditimpa**.

Hapus data uji hari ini: tahan tombol **BOOT** di ESP32 selama 3 detik (lihat bagian D).

### Pilihan lain di MULAI.bat (ketik **L** lalu Enter)
Tidak perlu dihafal; daftar ini juga tampil di layar.

| Ketik | Untuk |
|---|---|
| ENTER | Jalankan & perbarui semuanya (aman diulang kapan saja) |
| 2 | Nyalakan / nyalakan ulang Node-RED |
| 3 | Upload ulang firmware ke ESP32 |
| 4 | Buka Serial Monitor ESP32 (jendela sendiri) |
| 5 | Perbarui ThingsBoard, atau pindah ke akun ThingsBoard lain (perlu login) |
| 6 | Ganti WiFi / IP laptop (pindah jaringan) |
| 7 | Buka dashboard ThingsBoard & editor Node-RED (editor langsung masuk, tanpa password) |
| 8 | Pulihkan pengaturan dari cadangan |
| 9 | Cek kondisi: apa yang jalan, apa yang perlu diperbarui |
| 0 | Keluar |

**Pengaman bawaan** (berlaku di folder mana pun, termasuk folder yang sudah berjalan):
- Folder yang sudah berjalan dikenali dan dicatat apa adanya; tidak ada yang diubah kecuali dipilih sendiri.
- Kalau tidak ada yang berubah: tidak ada login, tidak ada upload.
- Sebelum pengaturan diubah (ganti WiFi, pindah akun, pulihkan), pengaturan lama dicadangkan ke folder `cadangan\`.
- Zip baru diekstrak ke folder lain: pengaturan dari folder lama ditawarkan untuk disalin.
- Node-RED dari folder lain yang sedang jalan: MULAI bertanya dulu sebelum menghentikannya.
- Serial Monitor yang terbuka ditutup otomatis saat upload firmware.

Daftar perubahan tiap versi: `dokumen\CATATAN-VERSI.txt`. Bagian A–F di bawah menjelaskan cara kerja dan cara manualnya (tidak perlu dibaca untuk pemakaian biasa).

---

> Panduan lengkap bergambar: menyusul (versi terbaru sedang dibuat).

> Setup ThingsBoard di akun sendiri: **otomatis** dengan `lanjutan\0-SETUP-THINGSBOARD.bat` (langkah A.2), atau manual dengan **dokumen\Panduan_Setup_ThingsBoard.pdf** dan folder **3-thingsboard**.

> **Aturan absen terbaru ada di file ini (bagian C dan D).** Kedua PDF masih memuat aturan lama ("pulang = scan 30 menit setelah masuk", "batas 24:00"). Kalau berbeda, ikuti PANDUAN.md ini.

Alur: **ESP32 → (MQTT TLS) → Node-RED di laptop → (MQTT TLS, Gateway API) → ThingsBoard Cloud**

ThingsBoard yang dibutuhkan (dibuat oleh `lanjutan\0-SETUP-THINGSBOARD.bat`, atau manual lewat **dokumen\Panduan_Setup_ThingsBoard.pdf**):
- Device **Gateway Node-RED** (dicentang sebagai gateway)
- Device **Absensi-01**, berisi shared attribute `jadwal` dan `karyawan`
- Rule chain dengan 3 alarm: titip absen, lupa absen pulang, lembur mingguan lebih dari 18 jam
- Dashboard **Absensi Karyawan e-KTP**
- Customer **HRD**

## Isi folder

| File / folder | Fungsi |
|---|---|
| **`MULAI.bat`** | **Satu-satunya yang perlu diklik**: pemasangan pertama, pembaruan, dan pemakaian sehari-hari |
| `BACA-SAYA.txt` | Cara pakai singkat |
| `lanjutan\` | Langkah manual satu per satu (tidak perlu untuk pemakaian biasa; MULAI.bat sudah menjalankannya):<br>`0-SETUP-THINGSBOARD.bat` setup / perbarui ThingsBoard · `1-SIAPKAN.bat` WiFi & sertifikat · `2-JALANKAN-NODE-RED.bat` menyalakan Node-RED · `3-UPLOAD-ESP32.bat` upload firmware + Serial Monitor |
| `dokumen\` | PDF panduan bergambar (aturan lama, lihat catatan di atas) dan `CATATAN-VERSI.txt` |
| `1-arduino/absensi_karyawan/` | Firmware ESP32 (`.ino`), `partitions.csv`, `secrets.h` dan `ca_cert.h` (dibuat oleh MULAI.bat) |
| `2-node-red/data/` | Flow Node-RED, `settings.js` |
| `3-thingsboard/` | Dashboard, rule chain (3 alarm), contoh atribut `jadwal` & `karyawan` untuk diimpor ke akun ThingsBoard sendiri |
| `sertifikat/` | CA kelompok, sertifikat broker, CA ThingsBoard |
| `rahasia.json` | Dibuat oleh MULAI.bat: password broker, token gateway, login editor. **Jangan diunggah / dibagikan** |
| `status-pemasangan.json` | Dibuat MULAI.bat: versi yang sudah terpasang (agar pembaruan hanya mengerjakan yang berubah) |
| `cadangan/` | Dibuat MULAI.bat: salinan pengaturan sebelum diubah (bisa dipulihkan: MULAI.bat, ketik L lalu 8). **Berisi rahasia, jangan dibagikan** |
| `tools/` | Skrip di balik MULAI.bat: setup ThingsBoard, sertifikat, flow, upload firmware, versi paket |

---

## A. Persiapan (sekali saja)

### 1. Nyalakan Mobile Hotspot laptop
1. Buka Settings → Network & internet → Mobile hotspot.
2. Atur:
   - Share my internet connection from: WiFi
   - Network band: **2.4 GHz** (ESP32 tidak bisa 5 GHz)
3. Klik Edit, isi nama dan password hotspot, lalu nyalakan.
4. Alamat laptop di hotspot ini selalu **192.168.137.1**.

> **Memakai WiFi lain?** Boleh (WiFi rumah, hotspot HP), asal 2.4 GHz dan laptop tersambung ke WiFi yang sama. MULAI.bat mendeteksi nama WiFi dan IP laptop sendiri. Pindah jaringan: MULAI.bat → ketik L → 6.

### 2. Siapkan ThingsBoard: jalankan `lanjutan\0-SETUP-THINGSBOARD.bat`
Butuh: akun di https://thingsboard.cloud (paket Free cukup; **akun yang dibuat lewat Google boleh**), Node.js 22 atau lebih baru, dan Google Chrome atau Microsoft Edge. Sebaiknya pakai akun khusus untuk proyek ini.

1. Klik dua kali `lanjutan\0-SETUP-THINGSBOARD.bat`.
2. Pilih cara login:
   - **1 (tekan Enter, disarankan): lewat jendela browser.** Jendela Chrome/Edge khusus terbuka di halaman login ThingsBoard → login seperti biasa, **misalnya klik tombol Google** → jendela tertutup sendiri setelah login berhasil.
     Jendela itu memakai profil browser **sementara** yang langsung dihapus setelahnya, jadi Chrome/Edge yang biasa Anda pakai tidak tersentuh dan password Gmail tidak pernah dilihat skrip.
   - **2: ketik email + password ThingsBoard** di jendela CMD (password tampil sebagai `*`). Hanya untuk akun yang punya password ThingsBoard; password Gmail tidak berlaku. Salah 3 kali → skrip berhenti.
   - Akun dengan verifikasi 2 langkah (2FA): pakai cara 1.
3. Skrip menampilkan akun yang sedang login. Ketik **Y** untuk lanjut, atau **N** untuk batal.
4. Skrip membuat (yang sudah ada dilewati, jadi aman dijalankan ulang):
   - rule chain **Rule Chain Absensi e-KTP** (3 alarm) dan device profile **Absensi e-KTP** yang memakainya
   - device **Gateway Node-RED** (Is gateway ON) dan **Absensi-01** (profile Absensi e-KTP)
   - shared attribute `jadwal` (isi `3-thingsboard/3-atribut-jadwal.json`) dan `karyawan` (`{}`). Atribut yang sudah ada tidak ditimpa.
   - dashboard **Absensi Karyawan e-KTP**, customer **HRD**, lalu Absensi-01 dan dashboard dipindah ke owner HRD
   - token Gateway Node-RED disimpan ke `rahasia.json` (tidak ditampilkan di layar). Kalau `rahasia.json` sudah berisi token akun lain, skrip **bertanya dulu** sebelum menggantinya (kalau diganti, Node-RED di laptop itu mengirim data ke akun yang baru login).
5. Di akhir sesi login ditutup.

**Keamanan login:** password (cara 2) hanya dikirim lewat HTTPS ke thingsboard.cloud dan tidak disimpan ke file mana pun. Sesi login (cara 1 maupun 2) hanya disimpan di memori selama skrip berjalan, lalu ditutup. Kode skripnya bisa dibaca di `tools/setup-thingsboard.js`. Pakai skrip hanya dari paket asli kelompok.

**Root rule chain akun tidak diganti.** Alarm dipasang lewat device profile *Absensi e-KTP*, jadi hanya berlaku untuk Absensi-01; device lain di akun tidak terpengaruh. (Cara manual di PDF menjadikan rule chain sebagai Root; hasil alarmnya sama.)

Ingin melihat dulu apa yang akan dibuat tanpa mengubah apa pun: jalankan dari CMD `lanjutan\0-SETUP-THINGSBOARD.bat --uji`.

> **Cara manual** (tanpa skrip): ikuti **dokumen\Panduan_Setup_ThingsBoard.pdf**, lalu salin token: Devices → **Gateway Node-RED** → **Manage credentials** → ikon salin di kolom *Access token* → **Cancel**. Di PDF itu, isi `batas_absen` dengan `21:00` (bukan 24:00).

### 3. Jalankan `lanjutan\1-SIAPKAN.bat`
Klik dua kali, lalu isi pertanyaannya:
- **IP laptop:** tekan Enter (192.168.137.1).
- **Nama dan password hotspot:** isi sesuai langkah 1.
- **Token gateway:** kalau langkah 2 memakai `lanjutan\0-SETUP-THINGSBOARD.bat`, cukup tekan **Enter** (sudah tersimpan). Kalau manual, tempel token yang disalin.
- **Password editor Node-RED:** isi sendiri, atau tekan Enter untuk dibuatkan acak.

Hasilnya:
- `rahasia.json`
- sertifikat di folder `sertifikat/`
- `secrets.h` dan `ca_cert.h` di folder firmware

Login editor ditampilkan di akhir dan tersimpan di `rahasia.json` (cadangan saja: editor biasanya terbuka langsung tanpa login).

### 4. Upload firmware ke ESP32 (Arduino IDE 2)
1. Boards Manager: pasang **esp32 by Espressif Systems** versi 3.x.
2. Library Manager: pasang
   - **MFRC522** (GithubCommunity)
   - **LiquidCrystal I2C** (Frank de Brabander)
   - **MQTT** (Joel Gaehwiler)
   - **ArduinoJson** (Benoit Blanchon, versi 7)
3. Buka `1-arduino/absensi_karyawan/absensi_karyawan.ino`.
4. Pilih Board **ESP32 Dev Module** dan port COM ESP32, lalu klik **Upload**.
   - `partitions.csv` di folder sketch otomatis dipakai untuk LittleFS (antrian offline).
5. Buka Serial Monitor, 115200 baud. Yang harus muncul:
   - `[RFID] versi RC522 0x92 OK` (atau 0x91 / 0x88)
   - `[HC-SR04] ECHO saat diam = LOW, uji awal (cm): ... -> OK`
   - `[WIFI] ... terhubung`
   - `[MQTT] terhubung ke Node-RED`. Baris ini baru muncul setelah langkah 5 di bawah.

> **Cara cepat (tanpa membuka Arduino IDE):** setelah board dan 4 library di atas terpasang, klik dua kali `lanjutan\3-UPLOAD-ESP32.bat`. Skrip mencari port ESP32 sendiri, compile, upload, lalu membuka Serial Monitor. Kalau port tidak ketemu, jalankan dari CMD: `lanjutan\3-UPLOAD-ESP32.bat COM5`.

### 5. Jalankan `lanjutan\2-JALANKAN-NODE-RED.bat`
1. Kalau Windows Firewall bertanya, centang **Private** dan **Public**, lalu klik **Allow**. Tanpa ini ESP32 tidak bisa masuk ke port 8883.
2. Editor Node-RED terbuka sendiri di browser dan **langsung masuk** (tanpa mengetik password), karena dibuka dengan kunci dari `rahasia.json`. Membuka lagi kapan saja: MULAI.bat → ketik L → 7. Kalau suatu saat tetap diminta login: user `admin`, password ada di `rahasia.json` (`editor_password`).
3. Cek status yang harus tampil:
   - **Tab 1:** node *Broker Absensi* menampilkan `connected 2`, yaitu Node-RED dan ESP32. Node *ThingsBoard* hijau `connected`.
   - **Tab 3:** node *Karyawan & jadwal* menampilkan `... karyawan diterima`.

---

## B. Mendaftarkan e-KTP karyawan

1. Karyawan berdiri di depan alat (< 50 cm dari HC-SR04), lalu menempelkan e-KTP. LCD menampilkan **Kartu belum / terdaftar**.
2. Ambil kode hash 16 karakter kartu tersebut, dari salah satu tempat ini:
   - Dashboard **Absensi Karyawan e-KTP**, kartu *Kartu baru (hash belum terdaftar)*
   - Device **Absensi-01** → Attributes → *Client attributes* → `kartu_baru`
   - Serial Monitor, baris `[EDGE] hash kartu: ...`
3. Buka Device **Absensi-01** → Attributes → pilih **Shared attributes** → baris `karyawan` → ikon edit.
4. Isi JSON seperti contoh di bawah, lalu simpan:
   ```json
   {"b8a9838810ebefb7": "Hasan H.", "05fbc1248a929e33": "Raffi P.", "27cddc4b02766bfd": "Alvin S."}
   ```
5. Dalam beberapa detik, Serial Monitor menampilkan `[CONFIG] daftar karyawan: ...`. Tempel kartu lagi; LCD menampilkan nama.

Untuk menghapus karyawan, hapus barisnya dari `karyawan`, lalu simpan.

---

## C. Aturan jam kerja (shared attribute `jadwal`)

```json
{"buka_absen":"07:00","jam_masuk":"08:00","istirahat":"12:00-13:00","jam_pulang":"17:00",
 "min_lembur":30,"blok_lembur":30,"maks_lembur":240,"maks_lembur_minggu":1080,"hari_kerja":"1-5","batas_absen":"21:00"}
```
Isi yang sama ada di `3-thingsboard/3-atribut-jadwal.json`. Kalau `batas_absen` tidak diisi, batasnya = `jam_pulang` + `maks_lembur` (17:00 + 4 jam = 21:00).

**Syarat setiap scan: ada orang di depan alat**
- Kartu hanya diproses kalau HC-SR04 mendeteksi orang < 50 cm.
- Kartu ditempel tanpa orang terdeteksi → LCD `Tdk terdeteksi! / Mendekat <50cm`, LED merah berkedip, 3 beep. Tidak dicatat.
- Saat orang terdeteksi: LED hijau berkedip + beep ringan, lalu LED hijau menyala redup-terang selama orang masih di depan alat.

**Absen masuk (sekali sehari)**
- Diterima dari `buka_absen` (07:00) sampai sebelum `jam_pulang` (17:00).
- Lewat `jam_masuk` (08:00) tetap tercatat hadir, ditambah menit terlambat. LCD `TERLAMBAT / 20 menit`, LED hijau menyala dan LED merah berkedip seperti lampu hazard.
- Scan lagi sebelum jam pulang → peringatan `Sdh absen masuk / Blm jam pulang`. **Tidak dicatat.**
- Sebelum 07:00 → `Absen blm dibuka`. Tidak dicatat.

**Absen pulang (sekali sehari)**
- Hanya diterima dari `jam_pulang` (17:00) sampai sebelum `batas_absen` (21:00).
- LCD menampilkan `Pulang 19:40`, lalu `Kerja 8j00m / Lembur 2j30m`.
- Scan lagi setelah pulang → `Sdh pulang 19:40`. Tidak dicatat.
- Belum absen masuk tetapi scan di jam pulang → `Blm absen masuk / Lapor ke HRD`, jam pulangnya dicatat.

**Istirahat:** 12:00–13:00 dipotong otomatis, hanya kalau rentang kerja melewatinya.

**Lembur**
- Dihitung setelah 17:00, minimal 30 menit, dalam kelipatan 30 menit.
- Paling banyak 4 jam sehari (sampai 21:00) dan 18 jam seminggu, sesuai PP 35/2021.

**Batas absen 21:00 dan lupa absen pulang**
- Mulai 21:00 scan tidak diterima lagi.
- Karyawan yang sudah masuk tetapi belum absen pulang dianggap **lupa absen pulang**: pulang dicatat 17:00 (jam pulang normal), **lembur tidak dihitung**.
- Node-RED menutup rekap hari itu otomatis pada pukul 21:00 dan ThingsBoard membuat alarm *Lupa absen pulang*.
- Karyawan itu menempel kartu setelah 21:00 → LCD `Lupa absen plg / Plg dicatat 17:00`. Yang lain → `Absen ditutup`.

**Mengubah jadwal untuk demo:** edit `jadwal`, misalnya `"jam_masuk"`, `"jam_pulang"`, dan `"batas_absen"` digeser ke sekitar jam sekarang, atau `"hari_kerja":"1-7"` agar Sabtu dan Minggu juga dihitung. ESP32 dan Node-RED langsung menerima perubahan. **Kembalikan nilai aslinya setelah demo.**

---

## D. Skenario demo / uji

Semua uji di bawah dilakukan sambil berdiri < 50 cm di depan HC-SR04, kecuali uji "tanpa orang".

| Uji | Cara | Hasil |
|---|---|---|
| Tanpa orang | Jauhkan badan (> 50 cm), tempel kartu | `Tdk terdeteksi! / Mendekat <50cm`, LED merah strobo, tidak dicatat |
| Masuk tepat | Tempel kartu sebelum `jam_masuk` | `Masuk 07:52`, LED hijau + dua nada naik |
| Masuk telat | Tempel kartu setelah `jam_masuk` | `Masuk 08:20`, lalu `TERLAMBAT / 20 menit`, LED hazard |
| Scan ulang | Tempel lagi sebelum `jam_pulang` | `Sdh absen masuk / Blm jam pulang`, tidak dicatat |
| Pulang + lembur | Tempel antara `jam_pulang` dan `batas_absen` | `Pulang 19:40`, lalu `Kerja 8j00m / Lembur 2j30m` |
| Pulang dua kali | Tempel lagi setelah pulang | `Sdh pulang 19:40`, tidak dicatat |
| Titip absen | Tempel kartu A, tunggu > 5 detik, tempel kartu B tanpa pergi dari depan alat | `TITIP ABSEN? / 1 orang 2 kartu`, alarm MAJOR di ThingsBoard |
| Lupa absen pulang | Masuk, jangan absen pulang, tunggu sampai `batas_absen` | Rekap: pulang 17:00, lembur 0, alarm *Lupa absen pulang* |
| Lewat batas | Tempel kartu setelah `batas_absen` | `Lupa absen plg / Plg dicatat 17:00` atau `Absen ditutup` |
| Offline | Saklar GPIO33 ke GND, tempel kartu, lalu kembalikan saklar | LCD `Q1`, data terkirim setelah online (`saat_offline = 1`) |
| Tutup hari | Node-RED tab **2. Tutup Hari** → klik tombol inject *Tutup hari ini (uji)* | Tabel rekap harian terisi, alarm *Lupa absen pulang* untuk yang belum pulang |
| Wireshark | Capture di adapter hotspot (*Local Area Connection\* ..*), filter `tcp.port == 8883` | Hanya Client Hello dan Application Data terenkripsi |

### Mengulang uji: tombol BOOT
Setiap kartu hanya bisa masuk dan pulang sekali sehari. Untuk mengulang uji dengan kartu yang sama:
1. **Tahan tombol BOOT** di board ESP32 (di samping port USB) selama **3 detik**. LCD: `Tahan BOOT 3 dtk`, lalu `Data uji dihapus`, kedua LED menyala dan 3 nada turun.
2. Data absen hari ini terhapus di **ESP32 dan Node-RED** (Node-RED menampilkan peringatan `RESET UJI dari tombol BOOT`). Di ThingsBoard tercatat event `RESET_UJI`.
3. Daftar karyawan, jadwal, dan antrian offline **tidak** ikut terhapus.

Dilepas sebelum 3 detik = batal. Jangan tertukar dengan tombol **EN/RST** (itu me-restart ESP32).

### Melihat jarak HC-SR04
Di Serial Monitor ketik `j` lalu Enter: setiap bacaan jarak ditampilkan (`[HC-SR04] jarak 35 cm ...`). Ketik `j` lagi untuk mematikan.

---

## E. Akun HRD / dosen (hanya bisa melihat)

1. ThingsBoard → Customers → **HRD** → Manage users → tanda **+**.
2. Isi email, lalu kirim atau salin link aktivasinya.

Device **Absensi-01** dan dashboard sudah dimiliki customer HRD.

---

## F. Kalau ada masalah

| Gejala | Penyebab / solusi |
|---|---|
| `versi RC522 0x00` atau `0xFF` | Kabel RC522 (SDA 5, SCK 18, MOSI 23, MISO 19, RST 4, **3.3V**) |
| `RC522 TIDAK TERDETEKSI` lalu `tersambung lagi` berganti-ganti | Kabel jumper RC522 kendor (paling sering MISO / GND). Ganti jumper; alat menyambung ulang RC522 sendiri tiap 3 detik, tanpa restart |
| Kartu selalu `Tdk terdeteksi!` | HC-SR04 tidak membaca orang. Ketik `j` di Serial Monitor; pastikan VCC HC-SR04 **5V** (cek jumper 5V/3.3V di expansion shield), TRIG 13, ECHO 14 lewat pembagi tegangan |
| ESP32 reset berulang (`POWERON_RESET` banyak) | Daya tidak stabil: ganti kabel USB, colok langsung ke laptop, rapikan kabel 5V/GND |
| WiFi gagal | Hotspot belum 2.4 GHz, atau nama/password di `secrets.h` salah (MULAI.bat → L → 6, isi ulang WiFi) |
| MQTT gagal, lastError berisi `X509` / `verify` | IP laptop berbeda dengan sertifikat. MULAI.bat → L → 6 (IP terdeteksi otomatis), lalu tekan Enter untuk upload ulang |
| MQTT gagal, `cek MQTT_USER/MQTT_PASS` | `secrets.h` tidak cocok dengan `rahasia.json`. MULAI.bat → L → 3 (upload ulang firmware) |
| MQTT gagal tanpa pesan jelas | Firewall Windows memblokir port 8883, atau Node-RED belum jalan |
| LCD `Jam belum sinkron` | Laptop tidak ada internet dan Node-RED mati. Nyalakan Node-RED (ia mengirim jam ke ESP32 tiap 60 detik) |
| Node *ThingsBoard* merah | Token gateway kosong atau salah di `rahasia.json`. Perbaiki lalu jalankan ulang Node-RED |
| LCD kosong | Putar potensiometer biru di belakang modul I2C (kontras) |

**Keamanan**
- `rahasia.json`, `secrets.h`, `ca_cert.h`, dan `sertifikat/*.key` sudah dikecualikan lewat `.gitignore`.
- Token bisa diganti kapan saja dari ThingsBoard (Manage credentials), lalu perbarui `rahasia.json`.
