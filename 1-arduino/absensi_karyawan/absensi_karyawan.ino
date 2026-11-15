/*
  ABSENSI KARYAWAN e-KTP BERBASIS IoT
  ESP32 (edge) -> MQTT over TLS -> Node-RED (broker Aedes + middleware) -> ThingsBoard Cloud
  -------------------------------------------------------------------------------------
  Perception : RC522 (UID e-KTP), HC-SR04 (ada orang di depan alat) | LCD 16x2, buzzer, LED
  Edge       : UID -> hash, keputusan absen masuk/pulang, hitung jam kerja & lembur,
               deteksi titip absen, antrian offline (LittleFS), ringkasan tiap 30 detik
  Aturan     : jadwal dikirim dari ThingsBoard lewat Node-RED (topik absensi/<id>/config)
               - kartu hanya diterima bila HC-SR04 mendeteksi orang (< 50 cm)
               - absen masuk sekali, mulai buka_absen sampai sebelum jam_pulang (lewat jam_masuk = terlambat)
               - absen pulang sekali, hanya dari jam_pulang sampai sebelum batas_absen (bawaan 21:00)
               - lewat batas_absen: yang sudah masuk tetapi belum pulang dianggap LUPA ABSEN PULANG,
                 pulang dicatat jam_pulang (17:00) dan lembur tidak dihitung
               - di luar aturan itu: hanya peringatan (LCD, LED, buzzer), TIDAK dicatat / dikirim
  Mode uji   : tahan tombol BOOT (GPIO0) 3 detik = data absen hari ini dihapus di ESP32 dan di Node-RED
               (daftar karyawan, jadwal, dan antrian offline tidak ikut terhapus)

  Board      : ESP32 Dev Module (ESP32 Arduino Core 3.x)
  Partition  : pakai partitions.csv di folder ini (otomatis dibaca Arduino IDE)
  Library    : MFRC522 (GithubCommunity), LiquidCrystal I2C (Frank de Brabander),
               MQTT (Joel Gaehwiler), ArduinoJson 7 (Benoit Blanchon)

  Isi secrets.h (salin dari secrets.example.h) dan ca_cert.h (dibuat oleh skrip sertifikat).
  Buka Serial Monitor 115200 untuk melihat setiap langkah.
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <MQTT.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <time.h>
#include <sys/time.h>
#include "esp_sntp.h"
#include "mbedtls/md.h"
#include "secrets.h"   // WIFI_SSID, WIFI_PASS, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS, DEVICE_ID
#include "ca_cert.h"   // CA_CERT: sertifikat CA kelompok untuk memeriksa broker Node-RED

// ================= PIN =================
#define PIN_SS        5    // RC522 SDA
#define PIN_RST       4    // RC522 RST
#define PIN_TRIG      13   // HC-SR04 TRIG
#define PIN_ECHO      14   // HC-SR04 ECHO (lewat pembagi tegangan 3 x 1 kOhm)
#define PIN_BUZZER    25
#define PIN_LED_HIJAU 26
#define PIN_LED_MERAH 27
#define PIN_SAKLAR    33   // saklar uji: tersambung ke GND = koneksi dianggap putus
#define PIN_TOMBOL_RESET 0 // tombol BOOT di board ESP32: tahan 3 detik = hapus data absen hari ini (uji)

// ================= PENGATURAN EDGE =================
const int  JARAK_DEKAT_CM = 50;              // orang dianggap berdiri di depan alat
const int  JARAK_MIN_CM   = 3;               // < 3 cm = derau (HC-SR04 hanya akurat mulai 2 cm)
const int  JARAK_MAKS_CM  = 400;             // tidak ada pantulan = tidak ada benda (dilaporkan 400)
const unsigned long ECHO_TIMEOUT_US = 40000; // HC-SR04 menahan ECHO ~38 ms bila tidak ada benda
const int  DEKAT_BERTURUT = 2;               // butuh 2 bacaan dekat berturut-turut (anti derau)
const unsigned long PERGI_MS      = 2000;   // dianggap pergi bila jauh > 2 detik
const unsigned long BACA_JARAK_MS  = 200;    // HC-SR04 dibaca 5x per detik (tidak dikirim)
const unsigned long DEBOUNCE_MS    = 5000;   // kartu yang sama dalam 5 detik diabaikan
const unsigned long RINGKASAN_MS   = 30000;  // ringkasan tiap 30 detik
const unsigned long LAYAR_MS       = 2500;   // lama satu layar hasil di LCD
const unsigned long KONEK_ULANG_MS = 10000;  // jeda mencoba sambung ulang broker
const int  MAKS_ANTRIAN = 300;              // batas pesan disimpan saat offline
const char* SALT = "absensi-ektp-2026";      // garam hash UID (jangan diubah setelah ada karyawan terdaftar)
const char* FILE_ANTRIAN = "/antrian.txt";

String TOPIK_EVENT, TOPIK_RINGKASAN, TOPIK_STATUS, TOPIK_CONFIG;
const char* TOPIK_WAKTU = "absensi/waktu";   // jam dari Node-RED (cadangan bila NTP tidak bisa)

MFRC522 rfid(PIN_SS, PIN_RST);
LiquidCrystal_I2C* lcd = nullptr;
WiFiClientSecure net;
MQTTClient mqtt(8192);
Preferences pref;

// ================= JADWAL (dari ThingsBoard, menit sejak 00:00) =================
struct Jadwal {
  int bukaAbsen = 7 * 60;
  int jamMasuk = 8 * 60;
  int istMulai = 12 * 60, istSelesai = 13 * 60;
  int jamPulang = 17 * 60;
  int minLembur = 30, blokLembur = 30, maksLembur = 240;
  int batasAbsen = 21 * 60;        // mulai jam ini scan ditolak & yang belum pulang ditutup otomatis
  uint8_t hariKerja = 0b0111110;   // bit 1..7 = Senin..Minggu (bawaan Senin-Jumat)
} J;

String karyawanJson = "{}";   // {"hash16":"Nama"} atau {"hash16":{"nama":"Nama", ...}}
String jadwalJson = "";

// ================= STATUS HARI INI (tetap ada saat offline / restart) =================
String absenJson = "{}";      // {"hash16":{"m":menitMasuk,"p":menitPulang,"t":menitTelat}}
long absenTanggal = 0;

// ================= HC-SR04 =================
int jarakCm = -1;
int dekatBerturut = 0;
bool debugJarak = false;      // ketik 'j' di Serial Monitor untuk melihat jarak setiap bacaan
bool adaOrang = false;
unsigned long terakhirDekat = 0, bacaJarakTerakhir = 0;
String kartuSesi = "";        // kartu pertama dari orang yang sedang berdiri di depan alat

// ================= PENGHITUNG EDGE =================
unsigned long sampelMentah = 0, pesanTerkirim = 0, jumlahScan = 0, orangTerdeteksi = 0;
unsigned long ringkasanTerakhir = 0;
int antrian = 0;

String uidTerakhir = "";
unsigned long uidTerakhirMs = 0, idleTerakhir = 0, cobaKonekTerakhir = 0;
unsigned long layar2Pada = 0, tampilSampai = 0;
bool modeOffline = false;

struct Hasil {
  String kode, nama;
  String l1, l2;            // layar 1
  String l3, l4;            // layar 2 (opsional)
  bool catat = false;       // true = absensi tercatat & dikirim; false = hanya peringatan
  int masuk = -1, pulang = -1, telat = 0, cepat = 0, normal = 0, lembur = 0;
} hasilTampil;

// Satu langkah pola LED + buzzer: kecerahan merah/hijau (0-255), nada (Hz), volume (0-1023), lama (ms)
struct Langkah { uint8_t merah, hijau; uint16_t frek, vol, ms; };

// =====================================================================
//  Utilitas
// =====================================================================
String jamTeks(int menit) {
  if (menit < 0) return "";
  char b[6];
  snprintf(b, sizeof(b), "%02d:%02d", menit / 60, menit % 60);
  return String(b);
}

String durasiTeks(int menit) {           // 150 -> "2j30m"
  char b[12];
  snprintf(b, sizeof(b), "%dj%02dm", menit / 60, menit % 60);
  return String(b);
}

int parseJam(const char* s, int bawaan) {
  int h, m;
  if (s && sscanf(s, "%d:%d", &h, &m) == 2) return h * 60 + m;
  return bawaan;
}

uint8_t parseHari(const char* s, uint8_t bawaan) {   // "1-5" atau "1,2,3,4,5,6"
  if (!s || !*s) return bawaan;
  int a, b;
  if (sscanf(s, "%d-%d", &a, &b) == 2 && a >= 1 && b <= 7 && a <= b) {
    uint8_t m = 0;
    for (int i = a; i <= b; i++) m |= (1 << i);
    return m;
  }
  uint8_t m = 0;
  for (const char* p = s; *p; p++) if (*p >= '1' && *p <= '7') m |= (1 << (*p - '0'));
  return m ? m : bawaan;
}

String keTeks(JsonVariantConst v) {
  String s;
  if (v.is<const char*>()) s = v.as<const char*>();
  else serializeJson(v, s);
  return s;
}

String uidKeHex(const MFRC522::Uid& u) {
  String s;
  for (byte i = 0; i < u.size; i++) {
    if (u.uidByte[i] < 0x10) s += "0";
    s += String(u.uidByte[i], HEX);
  }
  s.toUpperCase();
  return s;
}

String sha256Hex(const String& teks) {
  byte hasil[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&ctx);
  mbedtls_md_update(&ctx, (const unsigned char*)teks.c_str(), teks.length());
  mbedtls_md_finish(&ctx, hasil);
  mbedtls_md_free(&ctx);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", hasil[i]);
  hex[64] = '\0';
  return String(hex);
}

bool waktuValid() { return time(nullptr) > 1700000000; }

// =====================================================================
//  Hitung jam kerja & lembur (sama dengan fungsi hitungHarian di Node-RED)
// =====================================================================
int irisan(int a1, int a2, int b1, int b2) { return max(0, min(a2, b2) - max(a1, b1)); }

void hitungKerja(int M, int P, Hasil& r) {
  int wajib = J.jamPulang - J.jamMasuk - (J.istSelesai - J.istMulai);   // 480 menit
  int batasLembur = J.batasAbsen;                                         // 21:00
  int mulai = max(M, J.jamMasuk);                                         // datang lebih awal tidak dihitung
  int akhir = min(P, batasLembur);
  int kerja = max(0, akhir - mulai) - irisan(mulai, akhir, J.istMulai, J.istSelesai);
  if (kerja < 0) kerja = 0;
  r.telat = max(0, M - J.jamMasuk);
  r.cepat = max(0, J.jamPulang - P);
  int lemburMentah = min(max(0, kerja - wajib), max(0, akhir - J.jamPulang));
  r.lembur = lemburMentah < J.minLembur ? 0 : (lemburMentah / J.blokLembur) * J.blokLembur;
  r.normal = min(kerja, wajib);
}

// =====================================================================
//  LCD, buzzer, LED
// =====================================================================
void tulisBaris(uint8_t baris, String teks) {
  if (!lcd) return;
  if (teks.length() > 16) teks = teks.substring(0, 16);
  while (teks.length() < 16) teks += ' ';
  lcd->setCursor(0, baris);
  lcd->print(teks);
}

void tulisLcd(const String& b1, const String& b2) {
  tulisBaris(0, b1);
  tulisBaris(1, b2);
}

// ---------- LED & buzzer lewat PWM (LEDC), tanpa delay() supaya MQTT tetap jalan ----------
// LED: kanal 0-1 (8 bit, 0-255). Buzzer pasif: kanal 2 (10 bit, volume 0-1023, 512 = paling keras).
const uint8_t KANAL_HIJAU = 0, KANAL_MERAH = 1, KANAL_BUZZER = 2;
// struct Langkah didefinisikan di bagian atas (sebelum fungsi pertama) agar prototipe otomatis Arduino bisa di-compile

// Pola lampu + bunyi untuk setiap keadaan
const Langkah P_ORANG[] = {          // orang terdeteksi: kedip hijau + beep ringan
  {0, 200, 2700, 80, 45}, {0, 40, 0, 0, 60}};
const Langkah P_MASUK[] = {          // masuk tepat waktu: hijau + dua nada naik
  {0, 255, 2000, 512, 90}, {0, 255, 0, 0, 60}, {0, 255, 2600, 512, 160}, {0, 255, 0, 0, 1700}};
const Langkah P_TELAT[] = {          // terlambat: hijau tetap (hadir) + merah berkedip seperti lampu hazard, nada turun
  {255, 255, 1600, 512, 130}, {0, 255, 0, 0, 110}, {255, 255, 1250, 512, 130}, {0, 255, 0, 0, 110},
  {255, 255, 900, 512, 260},  {0, 255, 0, 0, 160}, {255, 255, 0, 0, 160},     {0, 255, 0, 0, 160},
  {255, 255, 0, 0, 160},      {0, 255, 0, 0, 160}, {255, 255, 0, 0, 160},     {0, 255, 0, 0, 1500}};
const Langkah P_PULANG[] = {         // pulang: hijau berkedip + tiga nada naik
  {0, 255, 1500, 512, 90}, {0, 0, 0, 0, 70}, {0, 255, 2000, 512, 90}, {0, 0, 0, 0, 70},
  {0, 255, 2600, 512, 180}, {0, 255, 0, 0, 3000}};
const Langkah P_SUDAH[] = {          // sudah absen / belum jam pulang: merah 2x + 2 beep pendek
  {255, 0, 1000, 512, 120}, {0, 0, 0, 0, 100}, {255, 0, 1000, 512, 120}, {255, 0, 0, 0, 1500}};
const Langkah P_DILUAR[] = {         // di luar jadwal: merah kedip lambat + nada rendah
  {255, 0, 600, 512, 260}, {0, 0, 0, 0, 200}, {255, 0, 600, 512, 260}, {0, 0, 0, 0, 200}, {255, 0, 0, 0, 1200}};
const Langkah P_TANPA_ORANG[] = {     // kartu ditempel tanpa orang terdeteksi: merah strobo + 3 beep cepat
  {255, 0, 2200, 512, 70}, {0, 0, 0, 0, 70}, {255, 0, 2200, 512, 70}, {0, 0, 0, 0, 70},
  {255, 0, 2200, 512, 70}, {0, 0, 0, 0, 70}, {255, 0, 0, 0, 70},      {0, 0, 0, 0, 70}, {255, 0, 0, 0, 900}};
const Langkah P_TIDAK_TERDAFTAR[] = { // kartu belum terdaftar: merah + nada panjang rendah
  {255, 0, 400, 512, 700}, {255, 0, 0, 0, 1300}};
const Langkah P_TITIP[] = {          // titip absen: merah-hijau bergantian cepat + 5 beep tinggi
  {255, 0, 2500, 512, 60}, {0, 255, 0, 0, 60}, {255, 0, 2500, 512, 60}, {0, 255, 0, 0, 60},
  {255, 0, 2500, 512, 60}, {0, 255, 0, 0, 60}, {255, 0, 2500, 512, 60}, {0, 255, 0, 0, 60},
  {255, 0, 2500, 512, 60}, {0, 255, 0, 0, 60}, {255, 0, 0, 0, 1200}};
const Langkah P_RESET[] = {          // data uji dihapus: kedua LED + tiga nada turun
  {255, 255, 2600, 512, 120}, {0, 0, 0, 0, 80}, {255, 255, 2000, 512, 120}, {0, 0, 0, 0, 80},
  {255, 255, 1400, 512, 260}, {0, 0, 0, 0, 1500}};

const Langkah* polaAktif = nullptr;
int polaJumlah = 0, polaKe = 0;
unsigned long polaMulai = 0;
int ledMerahNow = -1, ledHijauNow = -1;

void setLed(int merah, int hijau) {
  if (merah != ledMerahNow) { ledcWrite(PIN_LED_MERAH, merah); ledMerahNow = merah; }
  if (hijau != ledHijauNow) { ledcWrite(PIN_LED_HIJAU, hijau); ledHijauNow = hijau; }
}

void suara(int frek, int vol) {
  if (frek <= 0 || vol <= 0) { ledcWrite(PIN_BUZZER, 0); return; }
  ledcChangeFrequency(PIN_BUZZER, frek, 10);
  ledcWrite(PIN_BUZZER, vol);
}

void terapkanLangkah(const Langkah& s) {
  setLed(s.merah, s.hijau);
  suara(s.frek, s.vol);
}

void mulaiPola(const Langkah* p, int n) {
  polaAktif = p; polaJumlah = n; polaKe = 0; polaMulai = millis();
  terapkanLangkah(p[0]);
}
#define MULAI_POLA(p) mulaiPola(p, sizeof(p) / sizeof(p[0]))

void urusLampu() {
  if (polaAktif) {
    if (millis() - polaMulai >= polaAktif[polaKe].ms) {
      polaKe++;
      polaMulai = millis();
      if (polaKe >= polaJumlah) { polaAktif = nullptr; suara(0, 0); setLed(0, 0); }
      else terapkanLangkah(polaAktif[polaKe]);
    }
    return;
  }
  // Selama ada orang dan alat siap menerima kartu: LED hijau "bernapas"
  if (adaOrang && !tampilSampai) {
    unsigned long x = millis() % 1600;
    if (x > 800) x = 1600 - x;
    setLed(0, 6 + (int)(x * x / 2900));   // 6..226, naik-turun halus
  } else {
    setLed(0, 0);
  }
}

void tampilIdle() {
  String b2 = "--/-- --:--";
  struct tm t;
  if (getLocalTime(&t, 0)) {
    char b[12];
    strftime(b, sizeof(b), "%d/%m %H:%M", &t);
    b2 = b;
  }
  if (antrian > 0) b2 += " Q" + String(antrian);
  else b2 += mqtt.connected() ? " ON" : " OFF";
  tulisLcd(adaOrang ? "Tempelkan e-KTP" : "Absensi e-KTP", b2);
  idleTerakhir = millis();
}

void tampilkanHasil(const Hasil& r) {
  hasilTampil = r;
  tulisLcd(r.l1, r.l2);
  bool duaLayar = r.l3.length() > 0;
  layar2Pada = duaLayar ? millis() + LAYAR_MS : 0;
  tampilSampai = millis() + (duaLayar ? 2 * LAYAR_MS : LAYAR_MS + 500);

  const String& k = r.kode;
  if (k == "MASUK_TEPAT")                                    MULAI_POLA(P_MASUK);
  else if (k == "MASUK_TELAT")                               MULAI_POLA(P_TELAT);
  else if (k == "PULANG")                                    MULAI_POLA(P_PULANG);
  else if (k == "BELUM_JAM_PULANG" || k == "SUDAH_PULANG")   MULAI_POLA(P_SUDAH);
  else if (k == "TIDAK_ADA_ORANG")                           MULAI_POLA(P_TANPA_ORANG);
  else if (k == "TIDAK_TERDAFTAR")                           MULAI_POLA(P_TIDAK_TERDAFTAR);
  else if (k == "TITIP_ABSEN")                               MULAI_POLA(P_TITIP);
  else if (k == "RESET_UJI")                                 MULAI_POLA(P_RESET);
  else                                                       MULAI_POLA(P_DILUAR);   // belum buka, ditutup, libur, dll.
}

void urusLayar() {
  if (layar2Pada && (long)(millis() - layar2Pada) >= 0) {
    layar2Pada = 0;
    tulisLcd(hasilTampil.l3, hasilTampil.l4);
  }
  if (tampilSampai && (long)(millis() - tampilSampai) >= 0) {
    tampilSampai = 0;
    tampilIdle();
  }
  if (!tampilSampai && millis() - idleTerakhir > 1000) tampilIdle();
}

// =====================================================================
//  Data karyawan & jadwal (dari ThingsBoard lewat Node-RED)
// =====================================================================
void terapkanJadwal() {
  JsonDocument d;
  if (deserializeJson(d, jadwalJson)) return;
  J.bukaAbsen = parseJam(d["buka_absen"] | "07:00", J.bukaAbsen);
  J.jamMasuk  = parseJam(d["jam_masuk"]  | "08:00", J.jamMasuk);
  J.jamPulang = parseJam(d["jam_pulang"] | "17:00", J.jamPulang);
  int a, b, c, e;
  const char* ist = d["istirahat"] | "12:00-13:00";
  if (sscanf(ist, "%d:%d-%d:%d", &a, &b, &c, &e) == 4) { J.istMulai = a * 60 + b; J.istSelesai = c * 60 + e; }
  J.minLembur  = d["min_lembur"]  | J.minLembur;
  J.blokLembur = d["blok_lembur"] | J.blokLembur;
  J.maksLembur = d["maks_lembur"] | J.maksLembur;
  J.hariKerja  = parseHari(d["hari_kerja"] | "1-5", J.hariKerja);
  // batas absen bawaan = jam pulang + lembur maksimal (17:00 + 4 jam = 21:00), tidak lewat 23:59
  J.batasAbsen = min(parseJam(d["batas_absen"] | "", J.jamPulang + J.maksLembur), 24 * 60 - 1);
  Serial.printf("[JADWAL] buka %s, masuk %s, istirahat %s-%s, pulang %s, lembur maks %d menit, batas absen %s\n",
                jamTeks(J.bukaAbsen).c_str(), jamTeks(J.jamMasuk).c_str(), jamTeks(J.istMulai).c_str(),
                jamTeks(J.istSelesai).c_str(), jamTeks(J.jamPulang).c_str(), J.maksLembur,
                jamTeks(J.batasAbsen).c_str());
}

void pesanMasuk(String& topik, String& isi) {
  // Hanya membaca & menyimpan; tidak boleh publish dari dalam fungsi ini.
  if (topik == TOPIK_WAKTU) {
    long detik = isi.toInt();
    if (!waktuValid() && detik > 1700000000) {
      struct timeval tv = { detik, 0 };
      settimeofday(&tv, nullptr);
      Serial.println("[WAKTU] jam diambil dari Node-RED");
    }
    return;
  }
  JsonDocument d;
  if (deserializeJson(d, isi)) { Serial.println("[CONFIG] JSON tidak valid"); return; }
  if (!d["karyawan"].isNull()) {
    String baru = keTeks(d["karyawan"]);
    if (baru != karyawanJson) { karyawanJson = baru; pref.putString("karyawan", karyawanJson); }
    Serial.println("[CONFIG] daftar karyawan: " + karyawanJson);
  }
  if (!d["jadwal"].isNull()) {
    String baru = keTeks(d["jadwal"]);
    if (baru != jadwalJson) { jadwalJson = baru; pref.putString("jadwal", jadwalJson); }
    terapkanJadwal();
  }
}

String cariNama(const String& h) {
  JsonDocument d;
  if (deserializeJson(d, karyawanJson)) return "";
  JsonVariantConst v = d[h];
  if (v.is<const char*>()) return String(v.as<const char*>());
  if (v["nama"].is<const char*>()) return String(v["nama"].as<const char*>());
  return "";
}

int jumlahKaryawan() {
  JsonDocument d;
  if (deserializeJson(d, karyawanJson)) return 0;
  return d.as<JsonObjectConst>().size();
}

// =====================================================================
//  Keputusan absensi di ESP32 (EDGE) - tetap jalan walau koneksi putus
// =====================================================================
void cekGantiHari(struct tm& t) {
  long tg = (t.tm_year + 1900) * 10000L + (t.tm_mon + 1) * 100 + t.tm_mday;
  if (tg != absenTanggal) {
    absenTanggal = tg;
    absenJson = "{}";
    pref.putLong("tgl", absenTanggal);
    pref.putString("absen", absenJson);
    Serial.printf("[EDGE] hari baru %ld, status absen direset\n", tg);
  }
}

// Batas absen = jadwal.batas_absen (bawaan jam pulang + lembur maksimal = 21:00).
// Absen pulang diterima dari jam pulang sampai SEBELUM batas ini (sama dengan Node-RED yang menutup hari pada batas).
int batasPulang() { return J.batasAbsen; }

// Aturan waktu (fungsi murni, mudah diuji). m / p = menit absen masuk / pulang hari ini, -1 = belum.
// otomatis = pulang diisi otomatis karena lupa absen pulang.
const char* aturanWaktu(int menit, int m, int p, bool otomatis, bool hariKerja) {
  if (!hariKerja) return "HARI_LIBUR";
  if (m >= 0 && menit >= batasPulang() && (p < 0 || otomatis)) return "LUPA_ABSEN_PULANG";
  if (p >= 0) return "SUDAH_PULANG";                        // pulang hanya sekali
  if (m < 0) {
    if (menit < J.bukaAbsen) return "BELUM_BUKA";
    if (menit < J.jamPulang) return menit > J.jamMasuk ? "MASUK_TELAT" : "MASUK_TEPAT";
    if (menit < batasPulang()) return "LUPA_ABSEN_MASUK";    // datang di jam pulang tanpa absen masuk
    return "ABSEN_DITUTUP";
  }
  if (menit < J.jamPulang) return "BELUM_JAM_PULANG";      // sudah masuk, jam pulang belum tiba
  return "PULANG";                                          // jam pulang s.d. sebelum batas absen
}

Hasil putuskan(const String& h) {
  Hasil r;
  // Kartu hanya diterima bila HC-SR04 mendeteksi orang di depan alat
  if (!adaOrang) {
    r.kode = "TIDAK_ADA_ORANG"; r.l1 = "Tdk terdeteksi!"; r.l2 = "Mendekat <50cm";
    return r;
  }
  struct tm t;
  if (!getLocalTime(&t, 0)) {
    r.kode = "WAKTU_BELUM_SINKRON"; r.l1 = "Jam belum"; r.l2 = "sinkron (NTP)";
    return r;
  }
  cekGantiHari(t);

  r.nama = cariNama(h);
  if (r.nama == "") { r.kode = "TIDAK_TERDAFTAR"; r.l1 = "Kartu belum"; r.l2 = "terdaftar"; r.catat = true; return r; }

  // Satu orang (menurut HC-SR04) tidak boleh menempelkan dua kartu berbeda
  if (kartuSesi != "" && kartuSesi != h) {
    r.kode = "TITIP_ABSEN"; r.l1 = "TITIP ABSEN?"; r.l2 = "1 orang 2 kartu"; r.catat = true;
    return r;
  }
  kartuSesi = h;

  int hariIso = t.tm_wday == 0 ? 7 : t.tm_wday;   // 1 = Senin ... 7 = Minggu
  int menit = t.tm_hour * 60 + t.tm_min;
  JsonDocument a;
  deserializeJson(a, absenJson);
  int m = a[h]["m"] | -1;
  int p = a[h]["p"] | -1;
  bool otomatis = (a[h]["o"] | 0) == 1;
  r.kode = aturanWaktu(menit, m, p, otomatis, J.hariKerja & (1 << hariIso));
  r.l1 = r.nama;

  if (r.kode == "LUPA_ABSEN_PULANG") {
    // Lewat batas absen (21:00) tanpa absen pulang: pulang dicatat jam pulang normal, lembur 0.
    // Hanya disimpan di alat (untuk tampilan & ringkasan). Rekap resminya ditutup Node-RED pada batas absen.
    r.masuk = m; r.pulang = J.jamPulang;
    hitungKerja(m, J.jamPulang, r);
    r.lembur = 0;
    r.l2 = "Lupa absen plg";
    r.l3 = "Plg dicatat " + jamTeks(J.jamPulang);
    r.l4 = "Kerja " + durasiTeks(r.normal) + " L0";
    if (p < 0) {
      a[h]["p"] = J.jamPulang;
      a[h]["o"] = 1;
      absenJson = "";
      serializeJson(a, absenJson);
      pref.putString("absen", absenJson);
    }
    return r;
  }

  if (r.kode == "MASUK_TEPAT" || r.kode == "MASUK_TELAT") {
    r.masuk = menit;
    r.telat = max(0, menit - J.jamMasuk);
    r.l2 = "Masuk " + jamTeks(menit);
    if (r.telat > 0) { r.l3 = "TERLAMBAT"; r.l4 = String(r.telat) + " menit"; }
    r.catat = true;
    a[h]["m"] = menit;
    a[h]["t"] = r.telat;
  } else if (r.kode == "PULANG") {
    r.masuk = m; r.pulang = menit;
    hitungKerja(m, menit, r);
    r.l2 = "Pulang " + jamTeks(menit);
    r.l3 = "Kerja " + durasiTeks(r.normal);
    r.l4 = r.lembur > 0 ? "Lembur " + durasiTeks(r.lembur) : "Tanpa lembur";
    r.catat = true;
    a[h]["p"] = menit;
  } else if (r.kode == "LUPA_ABSEN_MASUK") {
    r.pulang = menit;
    r.l2 = "Blm absen masuk";
    r.l3 = "Plg tercatat"; r.l4 = "Lapor ke HRD";
    r.catat = true;
    a[h]["p"] = menit;
  } else {
    // Peringatan saja: tidak disimpan, tidak dikirim
    if (r.kode == "BELUM_JAM_PULANG") {
      r.l2 = "Sdh absen masuk";
      r.l3 = "Blm jam pulang"; r.l4 = "Mulai " + jamTeks(J.jamPulang);
    } else if (r.kode == "SUDAH_PULANG") {
      r.l2 = m >= 0 ? "Sdh pulang " + jamTeks(p) : "Sudah tercatat";
    } else if (r.kode == "BELUM_BUKA") {
      r.l1 = "Absen blm dibuka"; r.l2 = "Mulai " + jamTeks(J.bukaAbsen);
    } else if (r.kode == "ABSEN_DITUTUP") {
      r.l2 = "Absen ditutup";
      r.l3 = "Batas " + jamTeks(batasPulang()); r.l4 = "Lapor ke HRD";
    } else if (r.kode == "HARI_LIBUR") {
      r.l1 = "Hari libur"; r.l2 = "Tidak dicatat";
    }
    return r;
  }
  absenJson = "";
  serializeJson(a, absenJson);
  pref.putString("absen", absenJson);
  return r;
}

// Dipanggil tiap 30 detik: setelah batas absen, karyawan yang sudah masuk tetapi belum absen pulang
// ditutup otomatis (pulang = jam pulang normal, lembur 0) supaya ringkasan "di kantor" ikut benar.
void tutupOtomatis() {
  struct tm t;
  if (!getLocalTime(&t, 0)) return;
  cekGantiHari(t);
  if (t.tm_hour * 60 + t.tm_min < J.batasAbsen) return;
  JsonDocument a;
  if (deserializeJson(a, absenJson)) return;
  int n = 0;
  for (JsonPair kv : a.as<JsonObject>()) {
    int m = kv.value()["m"] | -1, p = kv.value()["p"] | -1;
    if (m >= 0 && p < 0) { kv.value()["p"] = J.jamPulang; kv.value()["o"] = 1; n++; }
  }
  if (!n) return;
  absenJson = "";
  serializeJson(a, absenJson);
  pref.putString("absen", absenJson);
  Serial.printf("[EDGE] lewat batas absen %s: %d karyawan lupa absen pulang -> pulang dicatat %s, lembur 0\n",
                jamTeks(J.batasAbsen).c_str(), n, jamTeks(J.jamPulang).c_str());
}

void hitungRekap(int& hadir, int& terlambat, int& diKantor, int& pulang) {
  hadir = terlambat = diKantor = pulang = 0;
  JsonDocument a;
  if (deserializeJson(a, absenJson)) return;
  for (JsonPairConst kv : a.as<JsonObjectConst>()) {
    int m = kv.value()["m"] | -1, p = kv.value()["p"] | -1, tl = kv.value()["t"] | 0;
    if (m < 0) continue;
    hadir++;
    if (tl > 0) terlambat++;
    if (p >= 0) pulang++; else diKantor++;
  }
}

// =====================================================================
//  Pengiriman ke Node-RED + antrian offline
// =====================================================================
bool kirim(const String& topik, const char* json) {
  if (!mqtt.connected()) return false;
  bool ok = mqtt.publish(topik.c_str(), json, false, 1);
  if (ok) pesanTerkirim++;
  return ok;
}

void kirimAtauSimpan(const char* json) {
  if (kirim(TOPIK_EVENT, json)) { Serial.printf("[MQTT] terkirim: %s\n", json); return; }
  if (antrian >= MAKS_ANTRIAN) { Serial.println("[EDGE] antrian penuh, data dibuang"); return; }
  File f = LittleFS.open(FILE_ANTRIAN, FILE_APPEND);
  if (f) { f.println(json); f.close(); antrian++; }
  Serial.printf("[EDGE] OFFLINE -> disimpan di antrian (%d): %s\n", antrian, json);
}

void kirimAntrian() {
  if (!mqtt.connected() || antrian == 0) return;
  File f = LittleFS.open(FILE_ANTRIAN, FILE_READ);
  if (!f) { antrian = 0; return; }
  String sisa = "";
  int terkirim = 0, gagal = 0;
  while (f.available()) {
    String baris = f.readStringUntil('\n');
    baris.trim();
    if (baris.length() == 0) continue;
    if (gagal == 0 && kirim(TOPIK_EVENT, baris.c_str())) terkirim++;
    else { sisa += baris + "\n"; gagal++; }
  }
  f.close();
  LittleFS.remove(FILE_ANTRIAN);
  if (sisa.length()) { File g = LittleFS.open(FILE_ANTRIAN, FILE_WRITE); g.print(sisa); g.close(); }
  antrian = gagal;
  Serial.printf("[EDGE] sinkron antrian: %d terkirim, %d tersisa\n", terkirim, gagal);
}

int hitungAntrian() {
  File f = LittleFS.open(FILE_ANTRIAN, FILE_READ);
  if (!f) return 0;
  int n = 0;
  while (f.available()) { if (f.read() == '\n') n++; }
  f.close();
  return n;
}

void kirimRingkasan() {
  if (millis() - ringkasanTerakhir < RINGKASAN_MS) return;
  ringkasanTerakhir = millis();
  tutupOtomatis();   // juga memeriksa ganti hari
  int hadir, terlambat, diKantor, pulang;
  hitungRekap(hadir, terlambat, diKantor, pulang);
  int total = jumlahKaryawan();

  JsonDocument d;
  d["ts"] = (uint64_t)time(nullptr) * 1000ULL;
  d["hadir"] = hadir;
  d["terlambat"] = terlambat;
  d["di_kantor"] = diKantor;
  d["sudah_pulang"] = pulang;
  d["belum_hadir"] = max(0, total - hadir);
  d["jumlah_karyawan"] = total;
  d["orang_terdeteksi"] = orangTerdeteksi;
  d["jumlah_scan"] = jumlahScan;
  d["sampel_mentah"] = sampelMentah;
  d["pesan_terkirim"] = pesanTerkirim + 1;   // termasuk pesan ringkasan ini
  d["antrian_offline"] = antrian;
  d["jarak_cm"] = jarakCm;
  d["rssi"] = WiFi.RSSI();
  String s;
  serializeJson(d, s);
  if (mqtt.connected()) kirim(TOPIK_RINGKASAN, s.c_str());
  Serial.printf("[EDGE] 30 detik terakhir: %lu data mentah -> %lu pesan dikirim\n", sampelMentah, pesanTerkirim);
  sampelMentah = pesanTerkirim = jumlahScan = orangTerdeteksi = 0;
}

// =====================================================================
//  Koneksi
// =====================================================================
bool konekMqtt() {
  if (WiFi.status() != WL_CONNECTED) return false;
  Serial.printf("[MQTT] menghubungkan ke broker Node-RED %s:%d (TLS) ...\n", MQTT_HOST, MQTT_PORT);
  tulisLcd("Menghubungkan", "Node-RED...");
  mqtt.setWill(TOPIK_STATUS.c_str(), "offline", true, 1);
  String clientId = String("esp32-") + DEVICE_ID;
  if (!mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASS)) {
    char e[100] = "";
    net.lastError(e, sizeof(e));
    Serial.printf("[MQTT] gagal (lastError=%d, returnCode=%d) %s\n", (int)mqtt.lastError(), (int)mqtt.returnCode(),
                  mqtt.returnCode() == 4 || mqtt.returnCode() == 5 ? "-> cek MQTT_USER/MQTT_PASS" : e);
    return false;
  }
  mqtt.publish(TOPIK_STATUS.c_str(), "online", true, 1);
  mqtt.subscribe(TOPIK_CONFIG.c_str(), 1);   // pesan retained: langsung dapat daftar karyawan & jadwal
  mqtt.subscribe(TOPIK_WAKTU, 0);
  Serial.println("[MQTT] terhubung ke Node-RED");
  return true;
}

void mulaiWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void cekSaklarOffline() {
  bool offline = digitalRead(PIN_SAKLAR) == LOW;
  if (offline == modeOffline) return;
  modeOffline = offline;
  if (modeOffline) {
    Serial.println("\n[UJI] Saklar OFFLINE: koneksi dianggap putus, alat tetap bekerja");
    mqtt.disconnect();
    WiFi.disconnect();
  } else {
    Serial.println("\n[UJI] Saklar ONLINE: menyambung kembali");
    mulaiWifi();
  }
  cobaKonekTerakhir = millis();
  if (!tampilSampai) tampilIdle();
}

// =====================================================================
//  Sensor
// =====================================================================
// Satu pengukuran HC-SR04 (5 V, ECHO lewat pembagi tegangan ke GPIO14).
// Hasil: jarak cm, JARAK_MAKS_CM bila tidak ada pantulan, -2 bila ECHO macet HIGH, -1 bila derau.
int ukurSekali() {
  bool macet = false;
  if (digitalRead(PIN_ECHO) == HIGH) {                    // ECHO masih tinggi: tunggu sebentar
    unsigned long t0 = micros();
    while (digitalRead(PIN_ECHO) == HIGH && micros() - t0 < 5000) {}
    if (digitalRead(PIN_ECHO) == HIGH) {
      // HC-SR04 tiruan menahan ECHO HIGH bila tidak ada pantulan (tidak ada benda di depan).
      // Tarik ECHO ke LOW sesaat untuk membuka kunci, lalu tetap dipicu ulang di bawah.
      macet = true;
      pinMode(PIN_ECHO, OUTPUT);
      digitalWrite(PIN_ECHO, LOW);
      delayMicroseconds(500);
      pinMode(PIN_ECHO, INPUT);
    }
  }
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(4);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long durasi = pulseIn(PIN_ECHO, HIGH, ECHO_TIMEOUT_US + 10000UL);
  if (durasi == 0 || durasi >= ECHO_TIMEOUT_US) return macet ? -2 : JARAK_MAKS_CM;   // tidak ada benda
  int cm = durasi / 58;
  if (cm < JARAK_MIN_CM) return -1;                      // derau
  return min(cm, JARAK_MAKS_CM);
}

// Median dari 3 pengukuran terakhir (satu pengukuran per 200 ms agar loop tidak tertahan)
// sehingga satu bacaan derau tidak dianggap orang
int riwayatJarak[3] = { JARAK_MAKS_CM, JARAK_MAKS_CM, JARAK_MAKS_CM };
uint8_t idxJarak = 0;
int jarakMentah = 0;
int bacaJarak() {
  int baru = ukurSekali();
  jarakMentah = baru;
  // ECHO macet HIGH = modul tidak menerima pantulan = tidak ada benda di depan.
  if (baru == -2) baru = JARAK_MAKS_CM;
  if (baru < 0) baru = riwayatJarak[(idxJarak + 2) % 3];   // derau: pakai bacaan sebelumnya
  riwayatJarak[idxJarak] = baru;
  idxJarak = (idxJarak + 1) % 3;
  int v[3] = { riwayatJarak[0], riwayatJarak[1], riwayatJarak[2] };
  if (v[0] > v[1]) { int t = v[0]; v[0] = v[1]; v[1] = t; }
  if (v[1] > v[2]) { int t = v[1]; v[1] = v[2]; v[2] = t; }
  if (v[0] > v[1]) { int t = v[0]; v[0] = v[1]; v[1] = t; }
  return v[1];
}

void cekOrang() {
  if (millis() - bacaJarakTerakhir < BACA_JARAK_MS) return;
  bacaJarakTerakhir = millis();
  jarakCm = bacaJarak();
  sampelMentah++;   // tanpa edge, setiap pembacaan ini akan menjadi satu pesan
  if (debugJarak) Serial.printf("[HC-SR04] jarak %d cm (mentah %d, ECHO %s)\n", jarakCm, jarakMentah,
                                digitalRead(PIN_ECHO) ? "H" : "L");
  bool dekatSekarang = jarakCm >= JARAK_MIN_CM && jarakCm < JARAK_DEKAT_CM;
  dekatBerturut = dekatSekarang ? min(dekatBerturut + 1, 100) : 0;
  bool dekat = dekatBerturut >= DEKAT_BERTURUT;
  if (dekat) {
    if (!adaOrang) {
      adaOrang = true;
      orangTerdeteksi++;
      kartuSesi = "";
      Serial.printf("[HC-SR04] orang terdeteksi (%d cm)\n", jarakCm);
      if (!tampilSampai) {
        tampilIdle();
        if (!polaAktif) MULAI_POLA(P_ORANG);   // kedip hijau + beep ringan
      }
    }
    terakhirDekat = millis();
  } else if (adaOrang && millis() - terakhirDekat > PERGI_MS) {
    adaOrang = false;
    kartuSesi = "";
    Serial.println("[HC-SR04] orang pergi");
    if (!tampilSampai) tampilIdle();
  }
}

// Cek RC522 tiap 3 detik: bila kabel sempat lepas (versi 0x00/0xFF), modul diinisialisasi ulang
// begitu tersambung lagi, tanpa perlu restart ESP32.
bool rfidOk = true;
unsigned long cekRfidTerakhir = 0;
void cekRfid() {
  if (millis() - cekRfidTerakhir < 3000) return;
  cekRfidTerakhir = millis();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  bool ok = !(v == 0x00 || v == 0xFF);
  if (ok && !rfidOk) {
    rfid.PCD_Init();
    Serial.printf("[RFID] RC522 tersambung lagi (versi 0x%02X), siap membaca kartu\n", v);
  } else if (!ok && rfidOk) {
    Serial.printf("[RFID] RC522 TIDAK TERDETEKSI (0x%02X): cek GND, 3.3V, MISO 19\n", v);
  }
  rfidOk = ok;
}

void bacaKartu() {
  if (!rfidOk) return;
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;
  sampelMentah++;
  String uid = uidKeHex(rfid.uid);
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  Serial.println("\n[RFID] UID terbaca: " + uid);

  if (uid == uidTerakhir && millis() - uidTerakhirMs < DEBOUNCE_MS) {
    Serial.println("[EDGE] kartu sama < 5 detik, diabaikan");
    return;
  }
  uidTerakhir = uid;
  uidTerakhirMs = millis();

  String h = sha256Hex(String(SALT) + uid).substring(0, 16);   // UID asli tidak pernah dikirim
  Serial.println("[EDGE] hash kartu: " + h);
  Hasil r = putuskan(h);
  jumlahScan++;
  String info = r.l3.length() ? r.l2 + " | " + r.l3 + " " + r.l4 : r.l2;
  Serial.printf("[EDGE] keputusan lokal: %s | %s | %s\n", r.kode.c_str(), r.nama.c_str(), info.c_str());
  tampilkanHasil(r);   // LCD + pola LED/buzzer (tidak menahan program)

  if (!r.catat) { Serial.println("[EDGE] peringatan saja, tidak dicatat & tidak dikirim"); return; }
  if (!waktuValid()) return;   // tanpa jam yang benar, data tidak dikirim
  JsonDocument d;
  d["ts"] = (uint64_t)time(nullptr) * 1000ULL;
  d["status"] = r.kode;
  d["nama"] = r.nama;
  d["kartu"] = h;
  d["masuk"] = jamTeks(r.masuk);
  d["pulang"] = jamTeks(r.pulang);
  d["kerja_menit"] = r.normal;
  d["lembur_menit"] = r.lembur;
  d["telat_menit"] = r.telat;
  d["titip_absen"] = r.kode == "TITIP_ABSEN" ? 1 : 0;
  d["saat_offline"] = mqtt.connected() ? 0 : 1;
  String s;
  serializeJson(d, s);
  kirimAtauSimpan(s.c_str());
}

// =====================================================================
//  Mode uji: tombol BOOT ditahan 3 detik = hapus data absen hari ini
// =====================================================================
const unsigned long TAHAN_RESET_MS = 3000;
unsigned long tombolDitekanSejak = 0;
bool resetSudah = false;

void hapusDataUji() {
  absenJson = "{}";
  pref.putString("absen", absenJson);
  kartuSesi = "";
  uidTerakhir = "";            // kartu terakhir boleh langsung ditempel lagi
  Serial.println("\n[UJI] tombol BOOT ditahan 3 detik: data absen hari ini dihapus");
  Hasil r;
  r.kode = "RESET_UJI"; r.l1 = "Data uji dihapus"; r.l2 = "Absen hari ini";
  tampilkanHasil(r);
  if (!waktuValid()) return;
  // Beri tahu Node-RED agar rekap hari ini ikut dikosongkan (masuk antrian bila sedang offline)
  JsonDocument d;
  d["ts"] = (uint64_t)time(nullptr) * 1000ULL;
  d["status"] = "RESET_UJI";
  d["saat_offline"] = mqtt.connected() ? 0 : 1;
  String s;
  serializeJson(d, s);
  kirimAtauSimpan(s.c_str());
}

void cekTombolReset() {
  bool ditekan = digitalRead(PIN_TOMBOL_RESET) == LOW;
  if (!ditekan) {
    if (tombolDitekanSejak && !resetSudah) tampilSampai = millis();   // dilepas sebelum 3 detik: batal
    tombolDitekanSejak = 0;
    resetSudah = false;
    return;
  }
  if (!tombolDitekanSejak) {
    tombolDitekanSejak = millis();
    tulisLcd("Tahan BOOT 3 dtk", "hapus data uji");
    layar2Pada = 0;
    tampilSampai = millis() + TAHAN_RESET_MS + 1000;
    return;
  }
  if (resetSudah || millis() - tombolDitekanSejak < TAHAN_RESET_MS) return;
  resetSudah = true;
  hapusDataUji();
}

// =====================================================================
//  Setup & loop
// =====================================================================
void setup() {
  Serial.begin(115200);
  ledcAttachChannel(PIN_LED_HIJAU, 5000, 8, KANAL_HIJAU);   // PWM: LED bisa redup-terang
  ledcAttachChannel(PIN_LED_MERAH, 5000, 8, KANAL_MERAH);
  ledcAttachChannel(PIN_BUZZER, 2000, 10, KANAL_BUZZER);    // PWM: nada & volume buzzer
  setLed(0, 0);
  suara(0, 0);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  pinMode(PIN_SAKLAR, INPUT_PULLUP);
  pinMode(PIN_TOMBOL_RESET, INPUT_PULLUP);

  TOPIK_EVENT     = String("absensi/") + DEVICE_ID + "/event";
  TOPIK_RINGKASAN = String("absensi/") + DEVICE_ID + "/ringkasan";
  TOPIK_STATUS    = String("absensi/") + DEVICE_ID + "/status";
  TOPIK_CONFIG    = String("absensi/") + DEVICE_ID + "/config";

  // LCD: cari alamat I2C otomatis (0x27 atau 0x3F)
  Wire.begin(21, 22);
  uint8_t alamat = 0x27;
  Wire.beginTransmission(0x27);
  if (Wire.endTransmission() != 0) {
    Wire.beginTransmission(0x3F);
    if (Wire.endTransmission() == 0) alamat = 0x3F;
  }
  lcd = new LiquidCrystal_I2C(alamat, 16, 2);
  lcd->init();
  lcd->backlight();
  Serial.printf("\n[LCD] alamat I2C 0x%02X\n", alamat);
  tulisLcd("Absensi e-KTP", "Memulai...");

  SPI.begin();
  rfid.PCD_Init();
  byte v = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  Serial.printf("[RFID] versi RC522 0x%02X %s\n", v, (v == 0x00 || v == 0xFF) ? "(TIDAK TERDETEKSI, cek kabel)" : "OK");
  rfidOk = !(v == 0x00 || v == 0xFF);

  // Uji awal HC-SR04: 5 pengukuran + level ECHO saat diam
  int adaJawab = 0, macet = 0;
  String uji = "";
  for (int i = 0; i < 5; i++) {
    int cm = ukurSekali();
    uji += String(cm) + " ";
    if (cm >= JARAK_MIN_CM && cm < JARAK_MAKS_CM) adaJawab++;
    if (cm == -2) macet++;
    delay(60);
  }
  Serial.printf("[HC-SR04] ECHO saat diam = %s, uji awal (cm): %s-> %s\n",
                digitalRead(PIN_ECHO) ? "HIGH" : "LOW", uji.c_str(),
                adaJawab ? "OK" : macet ? "ECHO tertahan HIGH = tidak ada benda di depan (normal untuk modul ini)"
                                        : "tidak ada pantulan (ruang kosong > 4 m, atau cek VCC 5V / TRIG 13 / ECHO 14)");
  Serial.println("[HC-SR04] ketik 'j' di Serial Monitor untuk melihat jarak setiap bacaan");

  pref.begin("absensi", false);
  karyawanJson = pref.getString("karyawan", "{}");
  jadwalJson   = pref.getString("jadwal", "");
  absenJson    = pref.getString("absen", "{}");
  absenTanggal = pref.getLong("tgl", 0);
  if (jadwalJson.length()) terapkanJadwal();
  if (!LittleFS.begin(true)) Serial.println("[EDGE] LittleFS gagal");
  antrian = hitungAntrian();
  Serial.printf("[EDGE] data lokal: %d karyawan, antrian=%d\n", jumlahKaryawan(), antrian);

  modeOffline = digitalRead(PIN_SAKLAR) == LOW;
  tulisLcd("Menghubungkan", "WiFi...");
  if (!modeOffline) {
    mulaiWifi();
    Serial.print("[WIFI] menghubungkan ke " WIFI_SSID);
    for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) { delay(250); Serial.print("."); }
    if (WiFi.status() == WL_CONNECTED) Serial.printf(" terhubung, IP %s\n", WiFi.localIP().toString().c_str());
    else Serial.println(" gagal, lanjut mode offline");
  }

  sntp_set_sync_interval(60000);
  configTzTime("WIB-7", "pool.ntp.org", "time.google.com");   // WIB = UTC+7
  struct tm t;
  if (WiFi.status() == WL_CONNECTED && getLocalTime(&t, 8000)) Serial.println("[NTP] waktu tersinkron");

  net.setCACert(CA_CERT);          // sertifikat broker diperiksa dengan CA kelompok
  net.setHandshakeTimeout(15);
  mqtt.begin(MQTT_HOST, MQTT_PORT, net);
  mqtt.setKeepAlive(30);
  mqtt.setCleanSession(true);
  mqtt.setTimeout(5000);
  mqtt.onMessage(pesanMasuk);
  if (!modeOffline && konekMqtt()) kirimAntrian();
  cobaKonekTerakhir = millis();
  ringkasanTerakhir = millis();
  tampilIdle();
}

void loop() {
  mqtt.loop();
  cekSaklarOffline();

  if (!modeOffline && !mqtt.connected() && !tampilSampai && millis() - cobaKonekTerakhir > KONEK_ULANG_MS) {
    cobaKonekTerakhir = millis();
    if (WiFi.status() != WL_CONNECTED) { Serial.println("[WIFI] menyambung ulang"); WiFi.reconnect(); }
    else if (konekMqtt()) kirimAntrian();
    tampilIdle();
  }

  // Serial Monitor: ketik 'j' untuk menyalakan/mematikan tampilan jarak HC-SR04 setiap bacaan
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'j' || c == 'J') {
      debugJarak = !debugJarak;
      Serial.printf("[HC-SR04] tampilan jarak %s\n", debugJarak ? "ON" : "OFF");
    }
  }

  cekTombolReset();
  cekOrang();
  cekRfid();
  bacaKartu();
  kirimRingkasan();
  urusLayar();
  urusLampu();
}
