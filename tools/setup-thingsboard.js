// Setup otomatis ThingsBoard Cloud untuk proyek absensi karyawan e-KTP.
// Dijalankan oleh MULAI.bat (atau lanjutan\0-SETUP-THINGSBOARD.bat). Butuh Node.js 22+ (login lewat browser memakai WebSocket bawaan)
// dan Google Chrome atau Microsoft Edge.
//
// Yang dibuat (yang sudah ada dengan nama sama dilewati, tidak dibuat dobel):
//   1. Rule chain "Rule Chain Absensi e-KTP" (3 alarm) dari 3-thingsboard/2-rule-chain-absensi.json
//   2. Device profile "Absensi e-KTP" yang memakai rule chain itu. Root rule chain akun TIDAK diganti.
//   3. Device "Gateway Node-RED" (Is gateway ON) dan "Absensi-01" (profile Absensi e-KTP)
//   4. Shared attribute jadwal & karyawan di Absensi-01 (hanya bila belum ada)
//   5. Dashboard "Absensi Karyawan e-KTP" dari 3-thingsboard/1-dashboard-absensi-karyawan.json
//   6. Customer HRD, lalu Absensi-01 dan dashboard dipindah ke owner HRD
//   7. Token Gateway Node-RED disimpan ke rahasia.json (dipakai MULAI.bat dan Node-RED)
//
// Cara login:
//   1) Lewat jendela browser (bawaan): skrip membuka Chrome/Edge dengan profil SEMENTARA, pengguna login seperti
//      biasa (tombol Google/GitHub atau email), lalu skrip mengambil sesi login dari jendela itu. Setelah itu
//      jendela ditutup dan profil sementara dihapus. Cocok untuk akun yang dibuat lewat Google.
//   2) Email + password ThingsBoard diketik di sini: password tidak tampil dan TIDAK disimpan ke file mana pun,
//      hanya dikirim lewat HTTPS ke alamat ThingsBoard di bawah.
//
// Pilihan: --uji  = hanya memeriksa (tidak mengubah apa pun di ThingsBoard / rahasia.json)
//          --host = alamat server lain (bawaan https://thingsboard.cloud)
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const net = require("net");
const path = require("path");
const readline = require("readline");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const D_TB = path.join(ROOT, "3-thingsboard");
const F_RAHASIA = path.join(ROOT, "rahasia.json");

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const UJI = args.includes("--uji");
const DARI_MULAI = args.includes("--dari-mulai");   // dipanggil MULAI.bat: tanpa daftar langkah berikutnya
const HOST = (arg("host") || "https://thingsboard.cloud").replace(/\/+$/, "");

const NAMA_RULE = "Rule Chain Absensi e-KTP";
const NAMA_PROFILE = "Absensi e-KTP";
const NAMA_GATEWAY = "Gateway Node-RED";
const NAMA_DEVICE = "Absensi-01";            // jangan diubah: dipakai Node-RED, firmware, dan dashboard
const NAMA_CUSTOMER = "HRD";

let JWT = null;

// ---------------------------------------------------------------- input
// Input dari pipe (uji otomatis): semua baris dibaca satu antrean agar tidak hilang di antara pertanyaan
let antrean = null;
const penunggu = [];
function barisPipa() {
  if (!antrean) {
    antrean = [];
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (l) => (penunggu.length ? penunggu.shift()(l) : antrean.push(l)));
    rl.on("close", () => { while (penunggu.length) penunggu.shift()(""); antrean.selesai = true; });
  }
  return new Promise((res) => (antrean.length ? res(antrean.shift()) : antrean.selesai ? res("") : penunggu.push(res)));
}

function tanya(teks) {
  if (!process.stdin.isTTY) {
    process.stdout.write(teks);
    return barisPipa().then((j) => { process.stdout.write("\n"); return j.trim(); });
  }
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(teks, (j) => { rl.close(); res(j.trim()); });
  });
}

// Mengolah ketikan mentah password. Kode kontrol terminal dibuang: tombol panah dan penanda
// "tempel" (ESC[200~ ... ESC[201~) yang dikirim terminal saat password ditempel dengan Ctrl+V / klik kanan.
// st = { s: isi password, esc: 0 biasa | 1 setelah ESC | 2 di dalam ESC[ ... , selesai, batal }
function olahKetikan(st, teks) {
  let tampil = "";
  for (const c of teks) {
    if (st.esc === 1) { st.esc = c === "[" || c === "O" ? 2 : 0; continue; }
    if (st.esc === 2) { if (c >= "@" && c <= "~") st.esc = 0; continue; }
    if (c === "\u001b") { st.esc = 1; continue; }
    if (c === "\r" || c === "\n") { st.selesai = true; break; }
    if (c === "\u0003") { st.batal = true; break; }
    if (c === "\u0008" || c === "\u007f") { if (st.s.length) { st.s = st.s.slice(0, -1); tampil += "\b \b"; } continue; }
    if (c >= " ") { st.s += c; tampil += "*"; }
  }
  return tampil;
}

// Input password tanpa menampilkan karakternya (diganti '*')
function tanyaPassword(teks) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return tanya(teks);          // input dari pipe (uji otomatis)
  return new Promise((res) => {
    process.stdout.write(teks);
    const st = { s: "", esc: 0 };
    const onData = (buf) => {
      process.stdout.write(olahKetikan(st, buf.toString("utf8")));
      if (st.batal) { process.stdout.write("\nDibatalkan. Tidak ada yang diubah.\n"); process.exit(1); }
      if (!st.selesai) return;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write(`  (${st.s.length} karakter)\n`);
      res(st.s);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------- REST API
// Memakai modul https bawaan Node (bukan fetch) supaya batas tunggu bisa diatur: fetch menyerah
// bila sambungan belum terbuka dalam 10 detik, padahal internet seluler kadang perlu lebih lama.
const BATAS_MS = (Number(arg("batas")) || 30) * 1000;   // batas tunggu sambungan & jawaban (detik)
const MAKS_COBA = 3;
const agen = { "https:": new https.Agent({ keepAlive: true }), "http:": new http.Agent({ keepAlive: true }) };
const GAGAL_SAMBUNG = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ECONNRESET"];

function kirimSekali(metode, url, body) {
  return new Promise((res, rej) => {
    const u = new URL(HOST + url);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (JWT) headers["X-Authorization"] = "Bearer " + JWT;
    if (data !== null) headers["Content-Length"] = Buffer.byteLength(data);
    let tersambung = false;   // false = permintaan belum sampai ke server, aman diulang
    const req = (u.protocol === "https:" ? https : http).request(u, { method: metode, headers, agent: agen[u.protocol], timeout: BATAS_MS }, (r) => {
      let teks = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (teks += c));
      r.on("end", () => {
        let d = null;
        try { d = teks ? JSON.parse(teks) : null; } catch (e) { d = teks; }
        res({ status: r.statusCode, data: d });
      });
      r.on("error", (e) => rej(Object.assign(e, { tersambung: true })));
    });
    req.on("socket", (s) => {
      if (!s.connecting) tersambung = true;   // sambungan lama dipakai ulang
      else s.once(u.protocol === "https:" ? "secureConnect" : "connect", () => (tersambung = true));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("batas tunggu habis"), { code: tersambung ? "JAWABAN_LAMA" : "SAMBUNG_LAMA" })));
    req.on("error", (e) => {
      // sambungan lama yang ternyata sudah ditutup server: permintaan belum diproses, aman diulang
      const bekas = req.reusedSocket && e.code === "ECONNRESET";
      rej(Object.assign(e, { tersambung: tersambung && !bekas }));
    });
    if (data !== null) req.write(data);
    req.end();
  });
}

async function api(metode, url, body) {
  for (let coba = 1; ; coba++) {
    try {
      return await kirimSekali(metode, url, body);
    } catch (e) {
      // Diulang hanya bila permintaan belum sampai ke server (tidak ada data yang terbuat dobel),
      // atau bila hanya membaca (GET).
      const bolehUlang = metode === "GET" || (!e.tersambung && (e.code === "SAMBUNG_LAMA" || GAGAL_SAMBUNG.includes(e.code)));
      const jelas = e.code === "SAMBUNG_LAMA" ? `server tidak menjawab dalam ${BATAS_MS / 1000} detik`
        : e.code === "JAWABAN_LAMA" ? `jawaban server lebih dari ${BATAS_MS / 1000} detik`
        : e.code === "ENOTFOUND" || e.code === "EAI_AGAIN" ? "alamat server tidak ditemukan (internet mati?)"
        : e.code || e.message;
      if (!bolehUlang || coba >= MAKS_COBA) throw new Error(`Tidak bisa menghubungi ${HOST}: ${jelas}. Cek koneksi internet lalu jalankan lagi.`);
      console.log(`         koneksi lambat (${jelas}), mencoba lagi ${coba + 1}/${MAKS_COBA} ...`);
      await new Promise((s) => setTimeout(s, 3000));
    }
  }
}

async function wajib(metode, url, body, langkah) {
  const r = await api(metode, url, body);
  if (r.status >= 200 && r.status < 300) return r.data;
  const pesan = r.data && r.data.message ? r.data.message : JSON.stringify(r.data);
  throw new Error(`${langkah} gagal (HTTP ${r.status}): ${pesan}`);
}

async function cariDevice(nama) {
  const r = await api("GET", "/api/tenant/devices?deviceName=" + encodeURIComponent(nama));
  if (r.status === 200) return r.data;
  if (r.status === 404) return null;
  throw new Error(`Mencari device ${nama} gagal (HTTP ${r.status})`);
}

async function cariDiDaftar(url, nama, kolom = "name") {
  const d = await wajib("GET", `${url}${url.includes("?") ? "&" : "?"}pageSize=100&page=0&textSearch=${encodeURIComponent(nama)}`, undefined, "Membaca daftar");
  return (d.data || []).find((x) => x[kolom] === nama) || null;
}

const bacaJson = (f) => JSON.parse(fs.readFileSync(path.join(D_TB, f), "utf8"));
const ok = (t) => console.log("  [OK]   " + t);
const ada = (t) => console.log("  [ADA]  " + t);
const akan = (t) => console.log("  [UJI]  akan " + t);
const info = (t) => console.log("         " + t);

function isiJwt(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8")); } catch (e) { return {}; }
}

// ---------------------------------------------------------------- login lewat jendela browser
const tidur = (ms) => new Promise((s) => setTimeout(s, ms));

function cariBrowser() {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const lokal = process.env.LOCALAPPDATA || "";
  const daftar = [
    [path.join(pf, "Google\\Chrome\\Application\\chrome.exe"), "Google Chrome"],
    [path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"), "Google Chrome"],
    [path.join(lokal, "Google\\Chrome\\Application\\chrome.exe"), "Google Chrome"],
    [path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"), "Microsoft Edge"],
    [path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"), "Microsoft Edge"],
  ];
  return daftar.find(([f]) => path.isAbsolute(f) && fs.existsSync(f)) || null;
}

function portBebas() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function ambilJson(url) {
  return new Promise((res, rej) => {
    const req = http.get(url, { timeout: 3000 }, (r) => {
      let t = "";
      r.on("data", (c) => (t += c));
      r.on("end", () => { try { res(JSON.parse(t)); } catch (e) { rej(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", rej);
  });
}

// Satu perintah DevTools ke jendela browser (hanya di 127.0.0.1)
function devtools(wsUrl, method, params = {}) {
  return new Promise((res) => {
    let ws;
    const habis = setTimeout(() => { try { ws.close(); } catch (e) {} res(null); }, 4000);
    try { ws = new WebSocket(wsUrl); } catch (e) { clearTimeout(habis); return res(null); }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (m) => {
      const d = JSON.parse(typeof m.data === "string" ? m.data : m.data.toString());
      if (d.id !== 1) return;
      clearTimeout(habis);
      try { ws.close(); } catch (e) {}
      res(d.result || null);
    };
    ws.onerror = () => { clearTimeout(habis); res(null); };
  });
}

async function loginBrowser() {
  if (typeof WebSocket !== "function") {
    console.log("  Node.js di laptop ini terlalu lama untuk login lewat browser (butuh versi 22 atau lebih baru).");
    console.log("  Pasang Node.js LTS terbaru dari https://nodejs.org, atau pilih cara 2.");
    return false;
  }
  const br = cariBrowser();
  if (!br) { console.log("  Google Chrome / Microsoft Edge tidak ditemukan. Pilih cara 2."); return false; }
  const [exe, namaBr] = br;
  const port = await portBebas();
  const profil = fs.mkdtempSync(path.join(os.tmpdir(), "absensi-tb-login-"));
  const alamat = HOST + "/login";
  const proses = spawn(exe, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profil}`,
    "--no-first-run", "--no-default-browser-check", "--disable-sync", "--new-window", alamat,
  ], { stdio: "ignore" });
  proses.on("error", () => {});
  console.log(`\n  Jendela ${namaBr} khusus login sudah dibuka di ${alamat}`);
  console.log("  Login di jendela itu seperti biasa (misalnya klik tombol Google lalu pilih akun).");
  console.log("  Jendela akan tertutup sendiri setelah login berhasil. Menunggu maksimal 10 menit (Ctrl+C = batal) ...");

  let token = null, pernahTersambung = false, gagalBeruntun = 0, alasan = "waktu 10 menit habis";
  const batas = Date.now() + 10 * 60 * 1000;
  while (!token && Date.now() < batas) {
    await tidur(1500);
    let halaman;
    try { halaman = await ambilJson(`http://127.0.0.1:${port}/json/list`); pernahTersambung = true; gagalBeruntun = 0; }
    catch (e) {
      if (pernahTersambung && ++gagalBeruntun >= 3) { alasan = "jendela browser ditutup sebelum login selesai"; break; }
      continue;
    }
    for (const h of halaman) {
      if (h.type !== "page" || !String(h.url).startsWith(HOST) || !h.webSocketDebuggerUrl) continue;
      const r = await devtools(h.webSocketDebuggerUrl, "Runtime.evaluate", { expression: "localStorage.getItem('jwt_token')", returnByValue: true });
      const v = r && r.result ? r.result.value : null;
      if (typeof v !== "string" || v.split(".").length !== 3) continue;
      const isi = isiJwt(v);
      if ((isi.scopes || []).includes("PRE_VERIFICATION_TOKEN")) continue;   // masih di langkah 2FA
      if (isi.exp && isi.exp * 1000 < Date.now()) continue;
      token = v;
      break;
    }
  }

  // Tutup jendela login dan hapus profil sementara (cookie Google di profil itu ikut terhapus)
  try {
    const ver = await ambilJson(`http://127.0.0.1:${port}/json/version`);
    await devtools(ver.webSocketDebuggerUrl, "Browser.close");
  } catch (e) {}
  for (let i = 0; i < 10 && proses.exitCode === null; i++) await tidur(500);
  try { proses.kill(); } catch (e) {}
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(profil, { recursive: true, force: true }); break; } catch (e) { await tidur(500); }
  }

  if (!token) { console.log(`  Login lewat browser tidak selesai: ${alasan}.`); return false; }
  JWT = token;
  console.log("  Sesi login diterima, jendela login ditutup.");
  return true;
}

// ---------------------------------------------------------------- login
async function login() {
  console.log(`Login ke ${HOST}`);
  console.log("Pakai akun ThingsBoard yang memang untuk proyek ini. Belum punya akun? Daftar di https://thingsboard.cloud/signup\n");
  console.log("Pilih cara login:");
  console.log("  1) Lewat jendela browser: login seperti biasa, BISA PAKAI TOMBOL GOOGLE (disarankan)");
  console.log("  2) Ketik email + password ThingsBoard di sini (akun Google tidak bisa, kecuali sudah dibuat password-nya)");
  const pilih = await tanya("Pilihan [1]: ");
  if (pilih !== "2") {
    if (await loginBrowser()) return;
    console.log("\nTidak ada yang diubah. Jalankan lagi, atau pilih cara 2.");
    process.exit(1);
  }
  console.log("\nCatatan: akun yang biasa login dengan tombol Google belum punya password ThingsBoard (password Gmail tidak berlaku).\n");
  for (let coba = 1; coba <= 3; coba++) {
    // penanda "tempel" dari terminal dibuang juga dari email
    const email = (await tanya("  Email    : ")).replace(/\u001b?\[20[01]~/g, "").trim();
    const password = await tanyaPassword("  Password : ");
    if (!email || !password) { console.log("  Email dan password wajib diisi.\n"); continue; }
    const r = await api("POST", "/api/auth/login", { username: email, password });
    if (r.status === 200 && r.data && r.data.token) {
      const isi = isiJwt(r.data.token);
      if ((isi.scopes || []).includes("PRE_VERIFICATION_TOKEN")) {
        console.log("\n  Akun ini memakai verifikasi 2 langkah (2FA). Skrip tidak mendukung 2FA:");
        console.log("  matikan 2FA sementara, atau ikuti dokumen\Panduan_Setup_ThingsBoard.pdf (cara manual).");
        process.exit(1);
      }
      JWT = r.data.token;
      return;
    }
    // Pesan asli server diterjemahkan supaya penyebabnya jelas
    const asli = r.data && r.data.message ? String(r.data.message) : "";
    let pesan;
    if (/locked/i.test(asli)) {
      pesan = "akun DIKUNCI sementara oleh ThingsBoard karena terlalu sering salah password. Tunggu beberapa menit, atau reset password lewat 'Forgot password' di thingsboard.cloud";
    } else if (/not active|disabled/i.test(asli)) {
      pesan = "akun belum aktif / dinonaktifkan. Cek email aktivasi dari ThingsBoard";
    } else if (/expired/i.test(asli)) {
      pesan = "password sudah kedaluwarsa. Login di browser dan ganti password dulu";
    } else if (r.status === 401) {
      pesan = "email atau password salah. Kalau akun ini biasanya login lewat tombol Google, password Gmail TIDAK berlaku: buat password ThingsBoard lewat 'Forgot password?' di halaman login";
    } else if (r.status === 429) {
      pesan = "terlalu banyak percobaan, tunggu sebentar";
    } else {
      pesan = `HTTP ${r.status}${asli ? ": " + asli : ""}`;
    }
    console.log(`  Login gagal: ${pesan}.${asli ? `\n  (pesan server: ${asli})` : ""}`);
    if (/locked|not active|disabled|expired/i.test(asli)) { console.log("\nTidak ada yang diubah. Skrip berhenti."); process.exit(1); }
    if (coba < 3) console.log("  Coba lagi.\n");
  }
  console.log("\nLogin gagal 3 kali. Tidak ada yang diubah. Skrip berhenti.");
  process.exit(1);
}

// ---------------------------------------------------------------- langkah setup
// Sidik isi file paket: dicatat di ThingsBoard supaya versi baru dari zip baru bisa dikenali dan ditimpa
const sidik = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(D_TB, f))).digest("hex").slice(0, 12);

async function langkahRuleChain() {
  console.log("\n1) Rule chain alarm (titip absen, lupa absen pulang, lembur mingguan)");
  const f = bacaJson("2-rule-chain-absensi.json");
  const versi = sidik("2-rule-chain-absensi.json");
  const lama = await cariDiDaftar("/api/ruleChains?type=CORE", NAMA_RULE);
  if (lama) {
    if (lama.additionalInfo && lama.additionalInfo.versiPaket === versi) { ada(`${NAMA_RULE} sudah versi terbaru.`); return lama.id; }
    if (UJI) { akan(`memperbarui isi ${NAMA_RULE} ke versi paket ini`); return lama.id; }
    // Timpa isi node dengan versi paket (rule chain yang sama, id tetap)
    const mdLama = await wajib("GET", `/api/ruleChain/${lama.id.id}/metadata`, undefined, "Membaca rule chain");
    const md = Object.assign({}, f.metadata, { ruleChainId: lama.id, version: mdLama.version });
    if (md.version == null) delete md.version;
    await wajib("POST", "/api/ruleChain/metadata", md, "Memperbarui node rule chain");
    const rcBaru = await wajib("GET", `/api/ruleChain/${lama.id.id}`, undefined, "Membaca rule chain");
    rcBaru.additionalInfo = Object.assign({}, rcBaru.additionalInfo, { versiPaket: versi });
    await wajib("POST", "/api/ruleChain", rcBaru, "Mencatat versi rule chain");
    ok(`${NAMA_RULE} diperbarui ke versi paket ini (${md.nodes.length} node).`);
    return lama.id;
  }
  if (UJI) { akan(`membuat ${NAMA_RULE}`); return null; }
  const rc = await wajib("POST", "/api/ruleChain", {
    name: NAMA_RULE, type: "CORE", debugMode: false, configuration: f.ruleChain.configuration,
    additionalInfo: Object.assign({}, f.ruleChain.additionalInfo, { versiPaket: versi }),
  }, "Membuat rule chain");
  const md = Object.assign({}, f.metadata, { ruleChainId: rc.id });
  delete md.version;
  await wajib("POST", "/api/ruleChain/metadata", md, "Mengisi node rule chain");
  ok(`${NAMA_RULE} dibuat (${md.nodes.length} node). Root rule chain akun tidak diubah.`);
  return rc.id;
}

async function langkahProfile(ruleChainId) {
  console.log("\n2) Device profile");
  const info0 = await cariDiDaftar("/api/deviceProfileInfos", NAMA_PROFILE);
  if (info0) {
    const p = await wajib("GET", "/api/deviceProfile/" + info0.id.id, undefined, "Membaca device profile");
    if (ruleChainId && (!p.defaultRuleChainId || p.defaultRuleChainId.id !== ruleChainId.id)) {
      if (UJI) akan(`menyambungkan profile ${NAMA_PROFILE} ke ${NAMA_RULE}`);
      else {
        p.defaultRuleChainId = ruleChainId;
        await wajib("POST", "/api/deviceProfile", p, "Memperbarui device profile");
        ok(`Profile ${NAMA_PROFILE} sudah ada, sekarang memakai ${NAMA_RULE}.`);
      }
    } else ada(`Profile ${NAMA_PROFILE} sudah ada.`);
    return p.id;
  }
  if (UJI) { akan(`membuat profile ${NAMA_PROFILE} yang memakai ${NAMA_RULE}`); return null; }
  const p = await wajib("POST", "/api/deviceProfile", {
    name: NAMA_PROFILE,
    description: "Perangkat absensi e-KTP. Memakai rule chain alarm absensi.",
    type: "DEFAULT", transportType: "DEFAULT", provisionType: "DISABLED",
    profileData: { configuration: { type: "DEFAULT" }, transportConfiguration: { type: "DEFAULT" }, provisionConfiguration: { type: "DISABLED" } },
    defaultRuleChainId: ruleChainId,
  }, "Membuat device profile");
  ok(`Profile ${NAMA_PROFILE} dibuat, memakai ${NAMA_RULE}.`);
  return p.id;
}

async function langkahDevice(profileId) {
  console.log("\n3) Device");
  // Gateway Node-RED: profile bawaan, Is gateway ON
  let gw = await cariDevice(NAMA_GATEWAY);
  if (gw) {
    if (!(gw.additionalInfo && gw.additionalInfo.gateway)) {
      if (UJI) akan(`menyalakan Is gateway di ${NAMA_GATEWAY}`);
      else {
        gw.additionalInfo = Object.assign({}, gw.additionalInfo, { gateway: true });
        gw = await wajib("POST", "/api/device", gw, "Memperbarui Gateway Node-RED");
        ok(`${NAMA_GATEWAY} sudah ada, Is gateway dinyalakan.`);
      }
    } else ada(`${NAMA_GATEWAY} sudah ada (Is gateway ON).`);
  } else if (UJI) akan(`membuat device ${NAMA_GATEWAY} (Is gateway ON)`);
  else {
    gw = await wajib("POST", "/api/device", {
      name: NAMA_GATEWAY,
      additionalInfo: { gateway: true, overwriteActivityTime: false, description: "Node-RED di laptop: broker lokal + logika jam kerja, diteruskan lewat Gateway API" },
    }, "Membuat Gateway Node-RED");
    ok(`${NAMA_GATEWAY} dibuat (Is gateway ON).`);
  }

  // Absensi-01: profile Absensi e-KTP
  let dev = await cariDevice(NAMA_DEVICE);
  if (dev) {
    if (profileId && dev.deviceProfileId.id !== profileId.id) {
      if (UJI) akan(`memindah ${NAMA_DEVICE} ke profile ${NAMA_PROFILE}`);
      else {
        dev.deviceProfileId = profileId;
        delete dev.type;
        dev = await wajib("POST", "/api/device", dev, "Memperbarui Absensi-01");
        ok(`${NAMA_DEVICE} sudah ada, sekarang memakai profile ${NAMA_PROFILE}.`);
      }
    } else ada(`${NAMA_DEVICE} sudah ada.`);
  } else if (UJI) akan(`membuat device ${NAMA_DEVICE} (profile ${NAMA_PROFILE})`);
  else {
    dev = await wajib("POST", "/api/device", {
      name: NAMA_DEVICE, label: "Pintu utama", deviceProfileId: profileId,
      additionalInfo: { gateway: false, description: "ESP32 + RC522 + HC-SR04, terhubung lewat Gateway Node-RED" },
    }, "Membuat Absensi-01");
    ok(`${NAMA_DEVICE} dibuat (profile ${NAMA_PROFILE}).`);
  }
  return { gw, dev };
}

async function langkahAtribut(dev) {
  console.log("\n4) Shared attribute jadwal & karyawan di Absensi-01");
  const isi = { jadwal: bacaJson("3-atribut-jadwal.json"), karyawan: bacaJson("4-atribut-karyawan.json") };
  let lama = [];
  if (dev) lama = await wajib("GET", `/api/plugins/telemetry/DEVICE/${dev.id.id}/values/attributes/SHARED_SCOPE?keys=jadwal,karyawan`, undefined, "Membaca atribut");
  const nilaiLama = {};
  for (const a of lama || []) {
    let v = a.value;
    if (typeof v === "string") { try { v = JSON.parse(v); } catch (e) {} }
    nilaiLama[a.key] = v;
  }
  const baru = {};
  for (const k of Object.keys(isi)) {
    if (!(k in nilaiLama)) { baru[k] = isi[k]; continue; }
    if (k === "jadwal" && nilaiLama.jadwal && typeof nilaiLama.jadwal === "object") {
      // Jadwal milik pengguna tidak ditimpa; hanya pengaturan BARU dari paket yang ditambahkan
      const kurang = Object.keys(isi.jadwal).filter((x) => !(x in nilaiLama.jadwal));
      if (kurang.length) {
        baru.jadwal = Object.assign({}, nilaiLama.jadwal);
        for (const x of kurang) baru.jadwal[x] = isi.jadwal[x];
        if (UJI || !dev) akan(`menambah pengaturan baru ke jadwal: ${kurang.join(", ")} (isi lama tetap)`);
        continue;
      }
    }
    ada(`${k} sudah ada, isinya tidak diubah${k === "karyawan" ? " (kartu yang sudah terdaftar tetap)" : ""}.`);
  }
  if (!Object.keys(baru).length) return;
  if (UJI || !dev) { if (!baru.jadwal || !("jadwal" in nilaiLama)) akan(`mengisi ${Object.keys(baru).join(" & ")}`); return; }
  await wajib("POST", `/api/plugins/telemetry/DEVICE/${dev.id.id}/attributes/SHARED_SCOPE`, baru, "Mengisi atribut");
  for (const k of Object.keys(baru)) {
    if (k === "jadwal" && "jadwal" in nilaiLama) ok("jadwal: pengaturan baru dari paket ditambahkan, isi lama tetap.");
    else ok(`${k} diisi${k === "jadwal" ? ` (masuk ${isi.jadwal.jam_masuk}, pulang ${isi.jadwal.jam_pulang}, batas absen ${isi.jadwal.batas_absen})` : " ({} = belum ada karyawan)"}.`);
  }
}

async function langkahDashboard() {
  console.log("\n5) Dashboard");
  const f = bacaJson("1-dashboard-absensi-karyawan.json");
  const versi = sidik("1-dashboard-absensi-karyawan.json");
  const konfigurasi = Object.assign({}, f.configuration, { versiPaket: versi });
  const lama = await cariDiDaftar("/api/tenant/dashboards", f.title, "title");
  if (lama) {
    const d = await wajib("GET", "/api/dashboard/" + lama.id.id, undefined, "Membaca dashboard");
    if (d.configuration && d.configuration.versiPaket === versi) { ada(`Dashboard "${f.title}" sudah versi terbaru.`); return lama; }
    if (UJI) { akan(`memperbarui dashboard "${f.title}" ke versi paket ini`); return lama; }
    d.configuration = konfigurasi;   // dashboard yang sama (id, owner HRD tetap), isinya ditimpa
    await wajib("POST", "/api/dashboard", d, "Memperbarui dashboard");
    ok(`Dashboard "${f.title}" diperbarui ke versi paket ini (${Object.keys(f.configuration.widgets || {}).length} widget).`);
    return lama;
  }
  if (UJI) { akan(`mengimpor dashboard "${f.title}"`); return null; }
  const d = await wajib("POST", "/api/dashboard", {
    title: f.title, configuration: konfigurasi, image: f.image || null,
    mobileHide: !!f.mobileHide, mobileOrder: f.mobileOrder == null ? null : f.mobileOrder,
  }, "Mengimpor dashboard");
  ok(`Dashboard "${f.title}" diimpor (${Object.keys(f.configuration.widgets || {}).length} widget, mencari device lewat nama ${NAMA_DEVICE}).`);
  return d;
}

async function langkahHrd(dev, dash) {
  console.log("\n6) Customer HRD (akses hanya melihat)");
  let c = null;
  const r = await api("GET", "/api/tenant/customers?customerTitle=" + encodeURIComponent(NAMA_CUSTOMER));
  if (r.status === 200) { c = r.data; ada("Customer HRD sudah ada."); }
  else if (UJI) akan("membuat customer HRD");
  else { c = await wajib("POST", "/api/customer", { title: NAMA_CUSTOMER }, "Membuat customer HRD"); ok("Customer HRD dibuat."); }

  const pindah = async (jenis, entitas, nama) => {
    if (!entitas) { if (UJI) akan(`memindah ${nama} ke owner HRD`); return; }
    if (c && entitas.ownerId && entitas.ownerId.id === c.id.id) { ada(`${nama} sudah milik HRD.`); return; }
    if (UJI || !c) { akan(`memindah ${nama} ke owner HRD`); return; }
    const h = await api("POST", `/api/owner/CUSTOMER/${c.id.id}/${jenis}/${entitas.id.id}`, []);
    if (h.status >= 200 && h.status < 300) ok(`${nama} sekarang milik HRD.`);
    else info(`[!] ${nama} gagal dipindah ke HRD (HTTP ${h.status}). Lakukan manual: Manage owner and groups -> HRD.`);
  };
  await pindah("DEVICE", dev, `Device ${NAMA_DEVICE}`);
  await pindah("DASHBOARD", dash, "Dashboard");
  info("Gateway Node-RED tetap milik akunmu (tidak dipindah).");
  info("Akun login HRD/dosen dibuat manual: Customers -> HRD -> Manage users -> + (lihat PANDUAN bagian E).");
}

async function langkahToken(gw) {
  console.log("\n7) Token Gateway Node-RED -> rahasia.json");
  let R = {};
  if (fs.existsSync(F_RAHASIA)) R = JSON.parse(fs.readFileSync(F_RAHASIA, "utf8"));
  const adaTokenLain = !!R.tb_gateway_token;
  if (!gw) {
    if (UJI) akan(adaTokenLain ? "MENGGANTI token gateway yang sudah ada di rahasia.json (Node-RED pindah ke akun ini; akan ditanya dulu)" : "menyimpan token gateway ke rahasia.json");
    return;
  }
  const cr = await wajib("GET", `/api/device/${gw.id.id}/credentials`, undefined, "Membaca token gateway");
  if (cr.credentialsType !== "ACCESS_TOKEN" || !cr.credentialsId) {
    info("[!] Kredensial Gateway Node-RED bukan access token. Salin manual (Manage credentials).");
    return;
  }
  if (R.tb_gateway_token === cr.credentialsId) { ada("Token di rahasia.json sudah sama."); return; }
  if (UJI) { akan(adaTokenLain ? "MENGGANTI token gateway yang sudah ada di rahasia.json (akan ditanya dulu)" : "menyimpan token gateway ke rahasia.json"); return; }
  if (adaTokenLain) {
    // rahasia.json sudah terhubung ke akun/gateway lain: jangan diganti diam-diam
    console.log("  [!]  rahasia.json di folder ini SUDAH berisi token gateway lain (kemungkinan akun ThingsBoard lain).");
    console.log("       Kalau diganti, Node-RED di laptop ini akan mengirim data ke akun yang sedang login sekarang.");
    const j = await tanya("       Ganti token di rahasia.json dengan token akun ini? (Y/N): ");
    if (!/^y(a|es)?$/i.test(j)) {
      info("Token TIDAK diganti. Token akun ini bisa disalin manual: Devices -> Gateway Node-RED -> Manage credentials.");
      return;
    }
  }
  R.tb_gateway_token = cr.credentialsId;
  fs.writeFileSync(F_RAHASIA, JSON.stringify(R, null, 2));
  ok("Token gateway disimpan ke rahasia.json (tidak ditampilkan di layar).");
}

// ---------------------------------------------------------------- utama
async function main() {
  console.log("\n=== Setup ThingsBoard otomatis: Absensi Karyawan e-KTP ===");
  if (UJI) console.log("MODE UJI: hanya memeriksa, tidak ada yang diubah.");
  if (!/^https:\/\//.test(HOST) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(HOST)) {
    console.log("Alamat server harus https://. Skrip berhenti.");
    process.exit(1);
  }
  console.log("");
  await login();

  const u = await wajib("GET", "/api/auth/user", undefined, "Membaca akun");
  const nama = [u.firstName, u.lastName].filter(Boolean).join(" ") || "-";
  console.log(`\nLogin berhasil.\n  Akun  : ${u.email}\n  Nama  : ${nama}\n  Peran : ${u.authority}`);
  if (u.authority !== "TENANT_ADMIN") {
    console.log("\nAkun ini bukan pemilik/admin (TENANT_ADMIN), jadi tidak bisa membuat device dan rule chain. Skrip berhenti.");
    process.exit(1);
  }
  console.log("\nYang akan dibuat atau diperbarui di akun ini (daftar karyawan & jadwal yang sudah ada tidak ditimpa):");
  console.log(`  rule chain "${NAMA_RULE}", device profile "${NAMA_PROFILE}", device "${NAMA_GATEWAY}" & "${NAMA_DEVICE}",`);
  console.log("  atribut jadwal & karyawan, dashboard, customer HRD, lalu token gateway disimpan ke rahasia.json.");
  console.log("  Root rule chain dan device lain di akun ini tidak diubah.");
  const lanjut = await tanya(`\nLanjutkan ${UJI ? "pemeriksaan" : "setup"} di akun ${u.email}? (Y/n, Enter = Ya): `);
  if (!/^(y(a|es)?)?$/i.test(lanjut)) { console.log("Dibatalkan. Tidak ada yang diubah."); process.exitCode = 3; return; }

  const rc = await langkahRuleChain();
  const prof = await langkahProfile(rc);
  const { gw, dev } = await langkahDevice(prof);
  await langkahAtribut(dev);
  const dash = await langkahDashboard();
  await langkahHrd(dev, dash);
  await langkahToken(gw);

  await api("POST", "/api/auth/logout").catch(() => {});
  JWT = null;
  console.log(`\n${UJI ? "Pemeriksaan" : "Setup ThingsBoard"} selesai. Sesi login sudah ditutup.`);
  if (!UJI && !DARI_MULAI) {
    console.log("\nLangkah berikutnya:");
    console.log("  Klik MULAI.bat di folder utama lalu tekan Enter (WiFi, upload ESP32, Node-RED).");
  }
}

main().catch((e) => {
  console.error("\n[GAGAL] " + e.message);
  if (!JWT) console.error("Belum login, jadi belum ada yang diubah. Cek internet lalu jalankan lagi.");
  else console.error("Yang sudah dibuat tetap ada. Perbaiki masalahnya lalu jalankan lagi: langkah yang sudah selesai akan dilewati.");
  process.exit(1);
});
