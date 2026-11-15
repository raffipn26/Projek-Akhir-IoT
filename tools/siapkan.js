// Wizard persiapan: membuat rahasia.json, sertifikat TLS (CA kelompok + broker), secrets.h dan ca_cert.h untuk ESP32.
// Dijalankan oleh MULAI.bat (atau lanjutan\1-SIAPKAN.bat). Aman dijalankan ulang: CA lama dipakai lagi, sertifikat broker dibuat ulang bila IP berubah.
// Mode tanpa tanya (untuk uji): node siapkan.js --ip 192.168.137.1 --ssid X --wifipass Y --token Z --non-interaktif
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const ROOT = path.join(__dirname, "..");
const forge = require(path.join(ROOT, "2-node-red", "data", "node_modules", "node-forge"));
const F_RAHASIA = path.join(ROOT, "rahasia.json");
const D_SERT = path.join(ROOT, "sertifikat");
const D_ARDUINO = path.join(ROOT, "1-arduino", "absensi_karyawan");

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : undefined; };
const nonInteraktif = args.includes("--non-interaktif");

const acak = (n) => crypto.randomBytes(n * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n);
const escC = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// WiFi yang sedang tersambung di laptop (nama & kanal; kanal > 14 = 5 GHz)
function wifiTerhubung() {
  try {
    const t = require("child_process").spawnSync("netsh", ["wlan", "show", "interfaces"], { encoding: "utf8" }).stdout || "";
    const ssid = (/^\s*SSID\s*:\s*(.+)$/m.exec(t) || [])[1];
    const kanal = Number((/^\s*(Channel|Saluran)\s*:\s*(\d+)/mi.exec(t) || [])[2] || 0);
    return ssid ? { ssid: ssid.trim(), kanal } : null;
  } catch (e) { return null; }
}

// IP laptop di jaringan yang dipakai ESP32 (hotspot laptop diutamakan, lalu adaptor WiFi)
function ipLaptop() {
  const daftar = [];
  for (const [nama, arr] of Object.entries(require("os").networkInterfaces())) {
    for (const n of arr || []) {
      if (n.family !== "IPv4" || n.internal || n.address.startsWith("169.254.")) continue;
      daftar.push({ nama, ip: n.address });
    }
  }
  const maya = /virtual|vethernet|vmware|virtualbox|loopback|bluetooth|tailscale|zerotier|vpn/i;
  const hotspot = daftar.find((d) => d.ip === "192.168.137.1");
  if (hotspot) return { ip: hotspot.ip, hotspot: true };
  const wifi = daftar.find((d) => /wi-?fi|wlan|wireless/i.test(d.nama) && !maya.test(d.nama));
  const lain = daftar.find((d) => !maya.test(d.nama));
  const p = wifi || lain;
  return p ? { ip: p.ip, hotspot: false } : null;
}

function tanya(rl, teks, bawaan) {
  return new Promise((res) => rl.question(`${teks}${bawaan !== undefined && bawaan !== "" ? ` [${bawaan}]` : ""}: `, (j) => res(j.trim() === "" ? bawaan : j.trim())));
}

function buatSertifikat(opsi) {
  const kunci = () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" }));
  };
  const serial = () => "01" + crypto.randomBytes(15).toString("hex");
  const sekarang = new Date(Date.now() - 24 * 3600 * 1000);   // mundur 1 hari: aman bila jam ESP32/laptop sedikit berbeda

  // ---- CA kelompok (dibuat sekali)
  let caCert, caKey;
  const fCaCrt = path.join(D_SERT, "ca.crt"), fCaKey = path.join(D_SERT, "ca.key");
  if (fs.existsSync(fCaCrt) && fs.existsSync(fCaKey)) {
    caCert = forge.pki.certificateFromPem(fs.readFileSync(fCaCrt, "utf8"));
    caKey = forge.pki.privateKeyFromPem(fs.readFileSync(fCaKey, "utf8"));
    console.log("  CA lama dipakai lagi (ESP32 tidak perlu diganti CA-nya).");
  } else {
    caKey = kunci();
    caCert = forge.pki.createCertificate();
    caCert.publicKey = forge.pki.setRsaPublicKey(caKey.n, caKey.e);
    caCert.serialNumber = serial();
    caCert.validity.notBefore = sekarang;
    caCert.validity.notAfter = new Date(sekarang.getTime() + 10 * 365 * 24 * 3600 * 1000);
    const attrs = [{ name: "commonName", value: "Absensi e-KTP CA" }, { name: "organizationName", value: "Proyek IoT Absensi" }];
    caCert.setSubject(attrs);
    caCert.setIssuer(attrs);
    caCert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    caCert.sign(caKey, forge.md.sha256.create());
    fs.writeFileSync(fCaCrt, forge.pki.certificateToPem(caCert));
    fs.writeFileSync(fCaKey, forge.pki.privateKeyToPem(caKey));
    console.log("  CA baru dibuat: sertifikat/ca.crt");
  }

  // ---- sertifikat broker (CN dan SAN = alamat IP laptop)
  const bKey = kunci();
  const b = forge.pki.createCertificate();
  b.publicKey = forge.pki.setRsaPublicKey(bKey.n, bKey.e);
  b.serialNumber = serial();
  b.validity.notBefore = sekarang;
  b.validity.notAfter = new Date(sekarang.getTime() + 5 * 365 * 24 * 3600 * 1000);
  b.setSubject([{ name: "commonName", value: opsi.ip }, { name: "organizationName", value: "Proyek IoT Absensi" }]);
  b.setIssuer(caCert.subject.attributes);
  b.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    // DNS berisi IP juga: mbedTLS di ESP32 mencocokkan nama host sebagai teks
    { name: "subjectAltName", altNames: [
      { type: 2, value: opsi.ip }, { type: 7, ip: opsi.ip }, { type: 7, ip: "127.0.0.1" }, { type: 2, value: "localhost" },
    ] },
    { name: "subjectKeyIdentifier" },
    { name: "authorityKeyIdentifier", keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  b.sign(caKey, forge.md.sha256.create());
  fs.writeFileSync(path.join(D_SERT, "broker.crt"), forge.pki.certificateToPem(b));
  fs.writeFileSync(path.join(D_SERT, "broker.key"), forge.pki.privateKeyToPem(bKey));
  console.log(`  Sertifikat broker untuk ${opsi.ip} dibuat: sertifikat/broker.crt`);
  return forge.pki.certificateToPem(caCert);
}

async function main() {
  console.log("\n=== Persiapan proyek absensi karyawan (ESP32 -> Node-RED -> ThingsBoard) ===\n");
  fs.mkdirSync(D_SERT, { recursive: true });
  let R = {};
  if (fs.existsSync(F_RAHASIA)) {
    R = JSON.parse(fs.readFileSync(F_RAHASIA, "utf8"));
    console.log("rahasia.json sudah ada: nilai lama dipakai bila jawaban dikosongkan.\n");
  }
  const rl = nonInteraktif ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = async (teks, kunciArg, bawaan) => (arg(kunciArg) !== undefined ? arg(kunciArg) : nonInteraktif ? bawaan : await tanya(rl, teks, bawaan));

  console.log("1) WiFi untuk ESP32. ESP32 dan laptop harus tersambung ke WiFi yang SAMA, dan WiFi-nya 2.4 GHz.");
  const deteksiIp = ipLaptop();
  const deteksiWifi = wifiTerhubung();
  if (deteksiIp && deteksiIp.hotspot) {
    console.log("   Mobile Hotspot laptop aktif (IP 192.168.137.1): isi nama dan password hotspot itu.");
  } else if (deteksiWifi) {
    console.log(`   Laptop sekarang tersambung ke WiFi "${deteksiWifi.ssid}" (IP ${deteksiIp ? deteksiIp.ip : "-"}). Tekan Enter untuk memakainya.`);
    if (deteksiWifi.kanal > 14) console.log("   [!] WiFi ini 5 GHz. ESP32 hanya bisa 2.4 GHz: pakai WiFi / hotspot HP 2.4 GHz.");
  }
  const ip = await q("   Alamat IP laptop", "ip", (deteksiIp && deteksiIp.ip) || R.ip || "192.168.137.1");
  const ssidBawaan = (deteksiIp && deteksiIp.hotspot ? R.wifi_ssid : (deteksiWifi && deteksiWifi.ssid) || R.wifi_ssid) || "";
  const ssid = await q("   Nama WiFi (SSID)", "ssid", ssidBawaan);
  // password lama tidak ditampilkan di layar; Enter = tetap memakai yang tersimpan (bila WiFi-nya sama)
  const passTersimpan = R.wifi_pass && ssid === R.wifi_ssid;
  const jawabPass = await q("   Password WiFi", "wifipass", passTersimpan ? "(tersimpan)" : "");
  const wifiPass = jawabPass === "(tersimpan)" ? R.wifi_pass : jawabPass;
  console.log("\n2) ThingsBoard: token perangkat 'Gateway Node-RED' (Devices -> Gateway Node-RED -> Manage credentials -> ikon salin).");
  if (R.tb_gateway_token) console.log("   Token sudah tersimpan dari setup ThingsBoard: cukup tekan Enter.");
  else console.log("   Boleh dikosongkan sekarang, lalu isi nanti di rahasia.json (tb_gateway_token).");
  // token lama tidak ditampilkan di layar; Enter = tetap memakai token yang tersimpan
  const jawabToken = await q("   Token gateway", "token", R.tb_gateway_token ? "(tersimpan)" : "");
  const token = jawabToken === "(tersimpan)" ? R.tb_gateway_token : jawabToken;
  console.log("\n3) Login editor Node-RED (http://127.0.0.1:1882).");
  const editorPass = await q("   Password editor (Enter = buat acak)", "editorpass", R.editor_password || acak(10));
  if (rl) rl.close();

  const ipLama = R.ip;
  R = Object.assign(R, {
    ip, wifi_ssid: ssid, wifi_pass: wifiPass, tb_gateway_token: token,
    tb_host: R.tb_host || "mqtt.thingsboard.cloud", tb_port: R.tb_port || 8883,
    editor_user: R.editor_user || "admin", editor_password: editorPass,
    mqtt_user: R.mqtt_user || "absensi-01", mqtt_pass: R.mqtt_pass || acak(16),
    credential_secret: R.credential_secret || acak(32), ui_port: R.ui_port || 1882,
  });

  console.log("\n4) Sertifikat TLS");
  let caPem;
  const adaBroker = fs.existsSync(path.join(D_SERT, "broker.crt")) && fs.existsSync(path.join(D_SERT, "ca.crt"));
  if (adaBroker && ipLama === ip && !args.includes("--sertifikat-baru")) {
    caPem = fs.readFileSync(path.join(D_SERT, "ca.crt"), "utf8");
    console.log("  Sertifikat sudah ada untuk IP ini, tidak dibuat ulang.");
  } else {
    caPem = buatSertifikat({ ip });
  }

  fs.writeFileSync(F_RAHASIA, JSON.stringify(R, null, 2));
  fs.mkdirSync(D_ARDUINO, { recursive: true });
  fs.writeFileSync(path.join(D_ARDUINO, "secrets.h"),
`// Dibuat otomatis oleh MULAI.bat. JANGAN diunggah ke GitHub.
#pragma once
#define WIFI_SSID   "${escC(ssid)}"
#define WIFI_PASS   "${escC(wifiPass)}"
#define MQTT_HOST   "${escC(ip)}"
#define MQTT_PORT   8883
#define MQTT_USER   "${escC(R.mqtt_user)}"
#define MQTT_PASS   "${escC(R.mqtt_pass)}"
#define DEVICE_ID   "absensi-01"
`);
  fs.writeFileSync(path.join(D_ARDUINO, "ca_cert.h"),
`// Dibuat otomatis oleh MULAI.bat: sertifikat CA kelompok untuk memeriksa broker Node-RED.
#pragma once
static const char CA_CERT[] = R"EOF(
${caPem.trim()}
)EOF";
`);

  console.log("\nSelesai. File yang dibuat/diperbarui:");
  console.log("  rahasia.json                         (rahasia, jangan diunggah)");
  console.log("  sertifikat\\ca.crt, broker.crt, broker.key");
  console.log("  1-arduino\\absensi_karyawan\\secrets.h dan ca_cert.h");
  console.log(`\nLogin editor Node-RED: user "${R.editor_user}", password "${R.editor_password}"`);
  if (!token) console.log("\n[!] Token gateway masih kosong: isi tb_gateway_token di rahasia.json sebelum menjalankan Node-RED.");
  if (!args.includes("--dari-mulai")) console.log("\nLangkah berikutnya: klik MULAI.bat lalu tekan Enter (upload ESP32 dan Node-RED).\n");
}

main().catch((e) => { console.error("Gagal:", e); process.exit(1); });
