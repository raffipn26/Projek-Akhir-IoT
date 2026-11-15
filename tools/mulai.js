// MULAI.bat: satu pintu untuk PEMASANGAN PERTAMA, PEMBARUAN dari zip baru, dan PEMAKAIAN SEHARI-HARI.
//
// - Belum pernah dipasang      -> langsung dipasang otomatis (ThingsBoard, WiFi, firmware, Node-RED).
// - Sudah pernah dipasang      -> muncul MENU (tekan angka). Pilihan 1 = jalankan & perbarui semuanya.
// - Aman di folder mana pun, termasuk folder yang sudah berjalan: pemasangan lama dikenali dan dicatat apa adanya,
//   tidak ada yang diubah kecuali dipilih sendiri lewat menu.
//
// Cara kerja pembaruan: setiap bagian paket (ThingsBoard, firmware ESP32, Node-RED) diberi "sidik" (hash isi file).
// Sidik yang sudah terpasang dicatat di status-pemasangan.json (tidak ikut di zip). Hanya bagian yang berubah yang
// dikerjakan ulang; bagian yang sama dilewati (tanpa login, tanpa upload).
//
// Data pribadi TIDAK pernah ditimpa oleh zip baru: rahasia.json (WiFi, token, password broker), sertifikat,
// secrets.h, ca_cert.h, rekap Node-RED, daftar karyawan & jadwal di ThingsBoard. Sebelum pengaturan diubah lewat menu,
// semuanya dicadangkan dulu ke folder cadangan\ (bisa dipulihkan lewat menu).
//
// Pilihan baris perintah:
//   --otomatis       = tanpa menu, langsung "jalankan & perbarui semuanya"
//   --atur-ulang     = tanya ulang WiFi / IP laptop, lalu upload ulang firmware
//   --tanpa-upload   = lewati upload firmware        --tanpa-nodered = jangan menghentikan / menyalakan Node-RED
//   --host URL       = server ThingsBoard lain (diteruskan ke setup-thingsboard.js)
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const F_RAHASIA = path.join(ROOT, "rahasia.json");
const F_STATUS = path.join(ROOT, "status-pemasangan.json");
const D_DATA = path.join(ROOT, "2-node-red", "data");
const D_CADANGAN = path.join(ROOT, "cadangan");
const F_PENUNJUK = process.env.ABSENSI_PENUNJUK || path.join(process.env.APPDATA || os.homedir(), "absensi-ektp", "folder-terakhir.txt");
const ARGS = process.argv.slice(2);
const OTOMATIS = ARGS.includes("--otomatis") || !process.stdin.isTTY;
const TANPA_UPLOAD = ARGS.includes("--tanpa-upload");
const TANPA_NODERED = ARGS.includes("--tanpa-nodered");
const HOST_ARG = ARGS.includes("--host") ? ["--host", ARGS[ARGS.indexOf("--host") + 1]] : [];
// --pilihan "9,0" = pilihan menu yang dijalankan berurutan tanpa menekan tombol (untuk uji / jalan pintas)
const PILIHAN = ARGS.includes("--pilihan") ? String(ARGS[ARGS.indexOf("--pilihan") + 1] || "").split(",") : null;
const CLI = [path.join(process.env.ProgramFiles || "C:\\Program Files", "Arduino IDE"), path.join(process.env.LOCALAPPDATA || "", "Programs", "Arduino IDE")]
  .map((d) => path.join(d, "resources", "app", "lib", "backend", "resources", "arduino-cli.exe")).find((f) => path.isAbsolute(f) && fs.existsSync(f)) || "arduino-cli";

const BAGIAN = {
  thingsboard: ["3-thingsboard/1-dashboard-absensi-karyawan.json", "3-thingsboard/2-rule-chain-absensi.json", "3-thingsboard/3-atribut-jadwal.json"],
  firmware: ["1-arduino/absensi_karyawan/absensi_karyawan.ino", "1-arduino/absensi_karyawan/partitions.csv",
             "1-arduino/absensi_karyawan/secrets.h", "1-arduino/absensi_karyawan/ca_cert.h"],
  nodered: ["2-node-red/data/flows.json", "2-node-red/data/flows_cred.json", "2-node-red/data/settings.js", "sertifikat/broker.crt"],
  paket: ["2-node-red/data/package.json"],
};
// File pribadi: dicadangkan sebelum diubah, dan dibawa saat pindah folder (tidak pernah ada di zip)
const FILE_PRIBADI = [
  "rahasia.json", "status-pemasangan.json",
  "sertifikat/ca.crt", "sertifikat/ca.key", "sertifikat/broker.crt", "sertifikat/broker.key",
  "1-arduino/absensi_karyawan/secrets.h", "1-arduino/absensi_karyawan/ca_cert.h",
];

const ada = (f) => fs.existsSync(path.join(ROOT, f));
const bacaJson = (f, bawaan) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return bawaan; } };
function sidik(daftar) {
  const h = crypto.createHash("sha256");
  for (const f of daftar) { const p = path.join(ROOT, f); h.update(f + ":"); if (fs.existsSync(p)) h.update(fs.readFileSync(p)); }
  return h.digest("hex").slice(0, 16);
}
const sidikSemua = () => Object.fromEntries(Object.keys(BAGIAN).map((k) => [k, sidik(BAGIAN[k])]));
const judul = (t) => console.log(`\n==== ${t} ====`);
const jalankan = (cmd, args, opsi = {}) => spawnSync(cmd, args, Object.assign({ stdio: "inherit", cwd: ROOT, shell: false }, opsi)).status;
const jalankanPerintah = (perintah, cwd) => spawnSync(perintah, { stdio: "inherit", cwd, shell: true }).status;   // perintah tetap, mis. npm
const versiPaket = () => bacaJson(path.join(__dirname, "versi.json"), {}).versi || "-";

function tanya(teks) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(teks, (j) => { rl.close(); res(j.trim()); });
  });
}
const ya = (j, bawaanYa = true) => (j === "" ? bawaanYa : /^y(a|es)?$/i.test(j));

// ---------------------------------------------------------------- status & cadangan
let R = {}, S = {};
function muat() { R = bacaJson(F_RAHASIA, {}); S = bacaJson(F_STATUS, null) || {}; }
function simpanStatus() { fs.writeFileSync(F_STATUS, JSON.stringify(Object.assign(S, { versi: versiPaket(), diperbarui: new Date().toISOString() }), null, 2)); }

function cadangkan(alasan) {
  const ada1 = FILE_PRIBADI.filter((f) => ada(f));
  if (!ada1.length) return null;
  const t = new Date(Date.now() + 7 * 3600000).toISOString();          // waktu WIB, mis. 2026-11-15T22:31:05
  const cap = t.slice(0, 10).replace(/-/g, "") + "-" + t.slice(11, 19).replace(/:/g, "");
  const d = path.join(D_CADANGAN, `${cap}-${alasan}`);
  for (const f of ada1) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(d, f)); }
  // simpan paling banyak 15 cadangan terbaru
  const semua = fs.readdirSync(D_CADANGAN).sort();
  for (const lama of semua.slice(0, Math.max(0, semua.length - 15))) fs.rmSync(path.join(D_CADANGAN, lama), { recursive: true, force: true });
  console.log(`  Pengaturan sekarang dicadangkan ke cadangan\\${path.basename(d)}`);
  return d;
}

// ---------------------------------------------------------------- pindah dari folder lama
function cariFolderLama() {
  const cocok = (d) => d && path.resolve(d) !== path.resolve(ROOT) && fs.existsSync(path.join(d, "rahasia.json")) && fs.existsSync(path.join(d, "tools", "siapkan.js"));
  try { const d = fs.readFileSync(F_PENUNJUK, "utf8").trim(); if (cocok(d)) return d; } catch (e) {}
  const home = os.homedir();
  const awal = ["Downloads", "Desktop", "Documents", "OneDrive\\Desktop", "OneDrive\\Documents"].map((x) => path.join(home, x));
  const temu = [];
  const telusur = (d, dalam) => {
    if (dalam > 3) return;
    let isi;
    try { isi = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    if (cocok(d)) temu.push(d);
    for (const e of isi) if (e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "cadangan"].includes(e.name)) telusur(path.join(d, e.name), dalam + 1);
  };
  for (const a of awal) telusur(a, 0);
  temu.sort((x, y) => fs.statSync(path.join(y, "rahasia.json")).mtimeMs - fs.statSync(path.join(x, "rahasia.json")).mtimeMs);
  return temu[0] || null;
}

async function bawaDariFolderLama() {
  if (ada("rahasia.json")) return;
  const lama = cariFolderLama();
  if (!lama) return;
  judul("Pemasangan lama ditemukan");
  console.log(`  Folder: ${lama}`);
  if (!OTOMATIS && !ya(await tanya("  Pakai pengaturan dari sana (WiFi, token, sertifikat, rekap)? (Y/n, Enter = Ya): "))) {
    console.log("  Tidak dipakai: folder ini dipasang sebagai pemasangan baru.");
    return;
  }
  for (const f of FILE_PRIBADI) {
    const dari = path.join(lama, f);
    if (!fs.existsSync(dari)) continue;
    fs.mkdirSync(path.dirname(path.join(ROOT, f)), { recursive: true });
    fs.copyFileSync(dari, path.join(ROOT, f));
  }
  const ctx = path.join(lama, "2-node-red", "data", "context");
  if (fs.existsSync(ctx)) fs.cpSync(ctx, path.join(D_DATA, "context"), { recursive: true });
  console.log("  Disalin. Folder lama tidak diubah.");
}

// ---------------------------------------------------------------- Node-RED & ESP32
function pidNodeRed() {
  const r = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  const baris = (r.stdout || "").split(/\r?\n/).find((l) => /:1882\s+\S+\s+LISTENING/i.test(l));
  return baris ? baris.trim().split(/\s+/).pop() : null;
}
// Node-RED yang sedang memakai port 1882 milik folder ini? (settings.js mencatat nomor prosesnya)
function milikFolderIni(pid) {
  try { return fs.readFileSync(path.join(D_DATA, ".node-red.pid"), "utf8").trim() === String(pid); } catch (e) { return false; }
}
function statusNodeRed() {
  const pid = pidNodeRed();
  if (!pid) return { pid: null, teks: "mati" };
  return milikFolderIni(pid) ? { pid, teks: "berjalan", milik: true }
                             : { pid, teks: "berjalan, tapi dari folder lain / dinyalakan di luar MULAI", milik: false };
}
function hentikanNodeRed(pid) {
  const t = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (!/node\.exe/i.test(t.stdout || "")) { console.log(`  [!] Port 1882 dipakai program lain (PID ${pid}), tidak dihentikan.`); return false; }
  spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
  for (let i = 0; i < 20 && pidNodeRed(); i++) spawnSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 250"]);
  return true;
}
function nyalakanNodeRed() {
  const bat = path.join(ROOT, "lanjutan", "2-JALANKAN-NODE-RED.bat");
  spawn("cmd.exe", ["/c", "start", "\"Node-RED absensi\"", `"${bat}"`], { cwd: ROOT, detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  console.log("  Node-RED dinyalakan di jendela baru (jangan ditutup). Editor: http://127.0.0.1:1882");
  console.log("  Kalau Windows Firewall bertanya, centang Private dan Public lalu Allow.");
}
function portEsp32() {
  const r = spawnSync("powershell", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\((COM\\d+)\\)' -and $_.Name -match 'CP210|CH34|CH910|USB.*(Serial|UART)' } | Select-Object -First 1 -ExpandProperty Name"], { encoding: "utf8" });
  const m = /\((COM\d+)\)/.exec(r.stdout || "");
  return m ? m[1] : null;
}
function uploadFirmware() {
  const kode = jalankan("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "upload-esp32.ps1"), "-TanpaMonitor"]);
  if (kode === 0) { S.firmware = sidik(BAGIAN.firmware); simpanStatus(); return "di-upload"; }
  if (kode === 2) return "BELUM: ESP32 tidak tercolok (colokkan, lalu klik MULAI.bat dan tekan ENTER lagi)";
  return "GAGAL (lihat pesan di atas)";
}
function bukaSerialMonitor() {
  const port = portEsp32();
  if (!port) { console.log("  ESP32 tidak tercolok."); return; }
  const cli = fs.existsSync(CLI) ? CLI : "arduino-cli";
  spawn("cmd.exe", ["/c", "start", "\"Serial Monitor ESP32\"", "powershell", "-NoExit", "-NoProfile", "-Command",
    `"& '${cli}' monitor -p ${port} -c baudrate=115200"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  console.log(`  Serial Monitor ${port} dibuka di jendela baru (ketik j + Enter untuk jarak HC-SR04, tutup jendelanya untuk berhenti).`);
}

// ---------------------------------------------------------------- langkah-langkah
async function langkahPaketNodeRed() {
  judul("Node-RED dan paket pendukung");
  if (spawnSync("where", ["node-red"], { stdio: "ignore" }).status !== 0) {
    console.log("  Node-RED belum terpasang, memasang (sekali saja) ...");
    if (jalankanPerintah("npm install -g --unsafe-perm node-red", ROOT) !== 0) throw new Error("Gagal memasang Node-RED (cek internet).");
  }
  const sp = sidik(BAGIAN.paket);
  if (!fs.existsSync(path.join(D_DATA, "node_modules")) || S.paket !== sp) {
    console.log("  Memasang/memperbarui paket pendukung Node-RED ...");
    if (jalankanPerintah("npm install --no-audit --no-fund", D_DATA) !== 0) throw new Error("Gagal memasang paket Node-RED (cek internet).");
    S.paket = sp; simpanStatus();
    return "dipasang";
  }
  console.log("  Sudah terpasang.");
  return "sudah";
}

async function langkahThingsBoard(paksa) {
  judul("ThingsBoard");
  const st = sidik(BAGIAN.thingsboard);
  if (!paksa && R.tb_gateway_token && S.thingsboard === st) { console.log("  Sudah versi terbaru (tidak perlu login)."); return "sudah terbaru"; }
  const pertama = !R.tb_gateway_token;
  console.log(pertama ? "  Pemasangan pertama di akun ThingsBoard-mu. Perlu login sekali."
                      : paksa ? "  Login untuk memperbarui ThingsBoard (atau pindah ke akun lain)."
                              : "  Ada pembaruan dashboard / rule chain / jadwal dari paket. Perlu login sekali.");
  if (!pertama) cadangkan("sebelum-thingsboard");
  const tokenLama = R.tb_gateway_token;
  const kode = jalankan(process.execPath, [path.join(__dirname, "setup-thingsboard.js"), "--dari-mulai", ...HOST_ARG]);
  R = bacaJson(F_RAHASIA, {});
  if (kode !== 0) {
    if (!R.tb_gateway_token) throw new Error("Setup ThingsBoard belum berhasil. Jalankan MULAI.bat lagi.");
    return "GAGAL / dibatalkan";
  }
  S.thingsboard = st; simpanStatus();
  if (tokenLama && R.tb_gateway_token !== tokenLama) S.nodered = "token-berganti";   // Node-RED perlu dinyalakan ulang
  return pertama ? "dipasang" : "diperbarui";
}

async function langkahWifi(paksa) {
  judul("WiFi dan sertifikat");
  const perlu = paksa || !R.wifi_ssid || !ada(BAGIAN.firmware[2]) || !ada(BAGIAN.firmware[3]) || !ada("sertifikat/broker.crt");
  if (!perlu) {
    console.log(`  Sudah diisi (WiFi "${R.wifi_ssid}", IP laptop ${R.ip}).`);
    if (!ipAktif()) console.log(`  [!] IP ${R.ip} tidak aktif di laptop sekarang. Nyalakan hotspot/WiFi yang sama, atau di menu ketik L lalu 6 (Ganti WiFi / IP laptop).`);
    return "sudah";
  }
  if (R.wifi_ssid) cadangkan("sebelum-ganti-wifi");
  console.log("  Isi WiFi 2.4 GHz yang dipakai ESP32 dan IP laptop. Tekan Enter untuk memakai nilai di dalam [ ].");
  if (jalankan(process.execPath, [path.join(__dirname, "siapkan.js"), "--dari-mulai"]) !== 0) throw new Error("Pengisian WiFi / sertifikat gagal.");
  R = bacaJson(F_RAHASIA, {});
  return "diisi";
}
const ipAktif = () => Object.values(os.networkInterfaces()).flat().some((n) => n && n.address === R.ip);

async function jalankanSemua(opsi = {}) {
  const hasil = {};
  if ((await langkahPaketNodeRed()) === "dipasang") S.nodered = "paket-berubah";
  hasil.thingsboard = await langkahThingsBoard(false);
  hasil.wifi = await langkahWifi(opsi.aturUlang);

  const nrBaru = sidik(BAGIAN.nodered);
  const nrBerubah = S.nodered !== nrBaru;
  const snr = TANPA_NODERED ? { pid: null } : statusNodeRed();
  let lewatiNodeRed = false;
  if (snr.pid && !snr.milik) {
    judul("Node-RED");
    console.log("  Node-RED yang sedang berjalan bukan dari folder ini (dari folder lain, atau dinyalakan sebelum MULAI dipakai).");
    if (OTOMATIS || ya(await tanya("  Hentikan lalu jalankan Node-RED dari folder ini? (Y/n, Enter = Ya): "))) {
      if (hentikanNodeRed(snr.pid)) console.log("  Dihentikan, akan dinyalakan dari folder ini.");
    } else lewatiNodeRed = true;
  } else if (snr.pid && nrBerubah) {
    judul("Node-RED");
    if (hentikanNodeRed(snr.pid)) console.log("  Node-RED versi lama dihentikan, akan dinyalakan lagi dengan versi baru.");
  }

  judul("Firmware ESP32");
  const fwBaru = sidik(BAGIAN.firmware);
  if (S.firmware === fwBaru) { console.log("  Sudah versi terbaru (tidak perlu upload)."); hasil.firmware = "sudah terbaru"; }
  else if (TANPA_UPLOAD) { console.log("  Dilewati (--tanpa-upload)."); hasil.firmware = "BELUM di-upload (--tanpa-upload)"; }
  else hasil.firmware = uploadFirmware();

  judul("Node-RED");
  if (TANPA_NODERED) { console.log("  Dilewati (--tanpa-nodered)."); hasil.nodered = "tidak disentuh (--tanpa-nodered)"; }
  else if (lewatiNodeRed) { console.log("  Node-RED dari folder lain dibiarkan berjalan."); hasil.nodered = "dibiarkan (Node-RED folder lain tetap jalan)"; }
  else {
    if (!pidNodeRed()) { nyalakanNodeRed(); hasil.nodered = nrBerubah ? "dinyalakan (versi baru)" : "dinyalakan"; }
    else { console.log("  Sudah berjalan dengan versi terbaru."); hasil.nodered = "sudah berjalan"; }
    S.nodered = nrBaru; simpanStatus();
  }

  judul("RINGKASAN");
  console.log(`  ThingsBoard : ${hasil.thingsboard}`);
  console.log(`  Firmware    : ${hasil.firmware}`);
  console.log(`  Node-RED    : ${hasil.nodered}`);
  const belum = Object.values(hasil).some((v) => /GAGAL|BELUM/.test(String(v)));
  if (belum) console.log("\nADA YANG BELUM SELESAI (lihat ringkasan). Perbaiki, lalu jalankan lagi: yang sudah beres akan dilewati.");
  else console.log("\nSemua sudah versi terbaru dan berjalan.");
}

// ---------------------------------------------------------------- menu
function kondisi() {
  const sb = sidikSemua();
  const fw = sidik(BAGIAN.firmware), nr = sidik(BAGIAN.nodered);
  const pembaruan = [];
  if (S.thingsboard !== sb.thingsboard) pembaruan.push("ThingsBoard");
  if (S.firmware !== fw) pembaruan.push("firmware");
  if (S.nodered !== nr || S.paket !== sb.paket) pembaruan.push("Node-RED");
  return {
    nodered: statusNodeRed().teks,
    esp32: portEsp32() || "tidak tercolok",
    pembaruan,
  };
}

function cekKondisiLengkap() {
  judul("Kondisi sekarang");
  const k = kondisi();
  console.log(`  Paket          : versi ${versiPaket()} (terpasang: ${S.versi || "-"})`);
  console.log(`  Perlu diperbarui: ${k.pembaruan.length ? k.pembaruan.join(", ") + "  -> tekan ENTER di menu" : "tidak ada"}`);
  console.log(`  Node-RED       : ${k.nodered}${k.nodered === "berjalan" ? " (editor http://127.0.0.1:1882)" : "  -> tekan ENTER di menu"}`);
  console.log(`  ESP32          : ${k.esp32}`);
  console.log(`  WiFi ESP32     : ${R.wifi_ssid || "-"}   IP laptop: ${R.ip || "-"} ${R.ip ? (ipAktif() ? "(aktif)" : "(TIDAK aktif: nyalakan hotspot/WiFi itu, atau di menu ketik L lalu 6)") : ""}`);
  console.log(`  ThingsBoard    : ${R.tb_gateway_token ? "terhubung (token tersimpan)" : "belum disiapkan -> tekan ENTER di menu"}`);
  const cad = fs.existsSync(D_CADANGAN) ? fs.readdirSync(D_CADANGAN).length : 0;
  console.log(`  Cadangan       : ${cad} buah${cad ? " (memulihkan: ketik L lalu 8)" : ""}`);
  console.log("\n  Ingat-ingat ringan: tahan tombol BOOT ESP32 3 detik = hapus data uji hari ini.");
}

async function pulihkanCadangan() {
  judul("Pulihkan pengaturan dari cadangan");
  const daftar = fs.existsSync(D_CADANGAN) ? fs.readdirSync(D_CADANGAN).sort().reverse().slice(0, 9) : [];
  if (!daftar.length) { console.log("  Belum ada cadangan."); return; }
  daftar.forEach((d, i) => console.log(`  ${i + 1}) ${d}`));
  const j = await tanya("  Pilih nomor (Enter = batal): ");
  const d = daftar[Number(j) - 1];
  if (!d) { console.log("  Batal."); return; }
  if (!ya(await tanya(`  Pulihkan ${d}? Pengaturan sekarang dicadangkan dulu. (Y/n, Enter = Ya): `))) { console.log("  Batal."); return; }
  cadangkan("sebelum-pulihkan");
  const asal = path.join(D_CADANGAN, d);
  for (const f of FILE_PRIBADI) {
    const p = path.join(asal, f);
    if (fs.existsSync(p)) { fs.mkdirSync(path.dirname(path.join(ROOT, f)), { recursive: true }); fs.copyFileSync(p, path.join(ROOT, f)); }
  }
  muat();
  console.log("  Dipulihkan. Tekan ENTER di menu supaya firmware / Node-RED ikut menyesuaikan.");
}

function bukaBrowser() {
  spawn("cmd.exe", ["/c", "start", "\"\"", "https://thingsboard.cloud"], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  if (pidNodeRed()) spawn(process.execPath, [path.join(__dirname, "buka-editor.js")], { detached: true, stdio: "ignore" }).unref();
  console.log("  Dibuka: thingsboard.cloud dan editor Node-RED (langsung masuk, tanpa password).");
  if (!pidNodeRed()) console.log("  Node-RED belum menyala: tekan ENTER di menu untuk menyalakannya, editor akan terbuka sendiri.");
  console.log(`  Kalau editor tetap meminta login: user "${R.editor_user || "admin"}", password "${R.editor_password || "-"}"`);
}

// Layar utama sederhana: ENTER = jalankan semuanya. Pilihan lain baru tampil setelah mengetik L.
async function menu() {
  let lengkap = false;
  for (;;) {
    const k = kondisi();
    console.log("\n====================== ABSENSI e-KTP ======================");
    console.log(`  Node-RED : ${k.nodered}`);
    console.log(`  ESP32    : ${k.esp32}`);
    console.log(`  Versi    : ${k.pembaruan.length ? "ADA PEMBARUAN (" + k.pembaruan.join(", ") + ")" : "semua terbaru"}`);
    console.log("");
    if (!lengkap) {
      console.log("  Tekan ENTER  = jalankan semuanya (aman diulang kapan saja)");
      console.log("  Ketik L      = pilihan lain          Ketik 0 = keluar");
    } else {
      console.log("  ENTER) Jalankan & perbarui semuanya");
      console.log("  2) Nyalakan / nyalakan ulang Node-RED");
      console.log("  3) Upload ulang firmware ke ESP32");
      console.log("  4) Buka Serial Monitor ESP32");
      console.log("  5) Perbarui ThingsBoard / pindah ke akun ThingsBoard lain");
      console.log("  6) Ganti WiFi / IP laptop");
      console.log("  7) Buka dashboard ThingsBoard & editor Node-RED di browser");
      console.log("  8) Pulihkan pengaturan dari cadangan");
      console.log("  9) Cek kondisi lengkap");
      console.log("  0) Keluar");
    }
    let p;
    if (PILIHAN) { p = PILIHAN.length ? PILIHAN.shift().trim() : "0"; console.log(`Pilihan: ${p}`); }
    else p = await tanya("Pilihan: ");
    if (/^l$/i.test(p)) { lengkap = true; continue; }
    lengkap = false;
    try {
      if (p === "" || p === "1") await jalankanSemua();
      else if (p === "2") {
        judul("Node-RED");
        const pid = pidNodeRed();
        if (pid && !ya(await tanya("  Node-RED sedang berjalan. Nyalakan ulang? (Y/n, Enter = Ya): "))) continue;
        if (pid) hentikanNodeRed(pid);
        nyalakanNodeRed(); S.nodered = sidik(BAGIAN.nodered); simpanStatus();
      } else if (p === "3") { judul("Upload firmware"); console.log("  " + uploadFirmware()); }
      else if (p === "4") { judul("Serial Monitor"); bukaSerialMonitor(); }
      else if (p === "5") {
        const tokenLama = R.tb_gateway_token;
        console.log("  " + (await langkahThingsBoard(true)));
        if (tokenLama && R.tb_gateway_token !== tokenLama && pidNodeRed()) {
          console.log("  Token ThingsBoard berganti: Node-RED dinyalakan ulang agar mengirim ke akun yang baru.");
          hentikanNodeRed(pidNodeRed()); nyalakanNodeRed(); S.nodered = sidik(BAGIAN.nodered); simpanStatus();
        }
      } else if (p === "6") {
        await langkahWifi(true);
        console.log("  WiFi/IP baru perlu di-upload ke ESP32 dan Node-RED perlu dinyalakan ulang.");
        if (ya(await tanya("  Lakukan sekarang? (Y/n, Enter = Ya): "))) await jalankanSemua();
      } else if (p === "7") { judul("Browser"); bukaBrowser(); }
      else if (p === "8") await pulihkanCadangan();
      else if (p === "9") cekKondisiLengkap();
      else if (p === "0") return;
      else console.log("  Pilihan tidak dikenal.");
    } catch (e) { console.log(`\n[GAGAL] ${e.message}`); }
  }
}

// ---------------------------------------------------------------- utama
async function main() {
  console.log(`\n=== MULAI: Absensi Karyawan e-KTP (paket versi ${versiPaket()}) ===`);
  await bawaDariFolderLama();
  muat();
  // Pemasangan yang sudah berjalan sebelum ada MULAI.bat: dicatat apa adanya, tidak ada yang diubah
  if (!fs.existsSync(F_STATUS) && R.tb_gateway_token && ada(BAGIAN.firmware[2]) && ada(BAGIAN.firmware[3])) {
    S = sidikSemua(); simpanStatus();
    console.log("Pemasangan yang sudah berjalan dikenali dan dicatat apa adanya (tidak ada yang diubah).");
  }
  try { fs.mkdirSync(path.dirname(F_PENUNJUK), { recursive: true }); fs.writeFileSync(F_PENUNJUK, ROOT); } catch (e) {}

  const sudahTerpasang = !!R.tb_gateway_token && !!R.wifi_ssid;
  if (PILIHAN && sudahTerpasang) { await menu(); return; }
  if (OTOMATIS || !sudahTerpasang) {
    if (!sudahTerpasang) console.log("Belum pernah dipasang di folder ini: dipasang otomatis sekarang. Ikuti saja yang tampil di layar.");
    await jalankanSemua({ aturUlang: ARGS.includes("--atur-ulang") });
    if (!sudahTerpasang) console.log("\nLain kali cukup klik MULAI.bat lalu tekan ENTER.");
    return;
  }
  await menu();
}

main().then(() => process.exit(0)).catch((e) => { console.error(`\n[GAGAL] ${e.message}`); process.exit(1); });
