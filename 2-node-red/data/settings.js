// Pengaturan Node-RED proyek absensi karyawan.
// Nilai rahasia (password broker, token ThingsBoard, password editor) dibaca dari ..\..\rahasia.json,
// lalu diberikan ke flow lewat variabel lingkungan ${...}. File flow tidak berisi rahasia apa pun.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
let R;
try {
  R = JSON.parse(fs.readFileSync(path.join(ROOT, "rahasia.json"), "utf8"));
} catch (e) {
  console.error("\n[!] rahasia.json belum ada atau rusak. Klik MULAI.bat dulu.\n");
  process.exit(1);
}
// MULAI.bat mengenali Node-RED milik folder ini lewat nomor proses yang dicatat di sini
try { fs.writeFileSync(path.join(__dirname, ".node-red.pid"), String(process.pid)); } catch (e) {}
const S = path.join(ROOT, "sertifikat");
process.env.ABSENSI_BROKER_CRT = path.join(S, "broker.crt");
process.env.ABSENSI_BROKER_KEY = path.join(S, "broker.key");
process.env.ABSENSI_CA_CRT = path.join(S, "ca.crt");
process.env.ABSENSI_TB_CA = path.join(S, "thingsboard-ca.pem");
process.env.ABSENSI_MQTT_USER = R.mqtt_user;
process.env.ABSENSI_MQTT_PASS = R.mqtt_pass;
process.env.TB_GATEWAY_TOKEN = R.tb_gateway_token || "";
process.env.TB_HOST = R.tb_host || "mqtt.thingsboard.cloud";
process.env.TB_PORT = String(R.tb_port || 8883);

const pengguna = { username: R.editor_user || "admin", permissions: "*" };
// Kunci masuk editor tanpa mengetik password: diturunkan dari credential_secret (rahasia, tidak pernah di zip).
// tools\buka-editor.js menghitung kunci yang sama lalu membuka http://127.0.0.1:1882/?access_token=<kunci>.
// Login username + password tetap berlaku seperti biasa.
const KUNCI_EDITOR = require("crypto").createHash("sha256")
  .update(String(R.credential_secret || R.editor_password || "") + ":editor-lokal").digest("hex");

module.exports = {
  uiPort: R.ui_port || 1882,
  flowFile: "flows.json",
  credentialSecret: R.credential_secret,
  // context disimpan ke berkas (data/context) agar status harian tetap ada setelah Node-RED dinyalakan ulang
  contextStorage: { default: { module: "localfilesystem" } },
  // tidak mengirim data pemakaian ke tim Node-RED dan tidak menampilkan dialog persetujuannya
  telemetry: { enabled: false, updateNotification: false },
  // editor dikunci dengan login; dari laptop ini dibuka langsung lewat kunci (MULAI.bat / Node-RED dinyalakan)
  adminAuth: {
    type: "credentials",
    users: (u) => Promise.resolve(u === pengguna.username ? pengguna : null),
    authenticate: (u, p) => Promise.resolve(u === pengguna.username && p === R.editor_password ? pengguna : null),
    tokens: (t) => Promise.resolve(t === KUNCI_EDITOR ? pengguna : null),
  },
  editorTheme: { projects: { enabled: false }, tours: false, page: { title: "Node-RED Absensi Karyawan" } },
  logging: { console: { level: "info", metrics: false, audit: false } },
};
