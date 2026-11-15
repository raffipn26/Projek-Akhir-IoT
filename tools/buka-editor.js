// Membuka editor Node-RED di browser LANGSUNG MASUK (tanpa mengetik username & password).
// Kuncinya dihitung dari rahasia.json dengan cara yang sama seperti 2-node-red\data\settings.js.
// Menunggu sampai Node-RED siap (maksimal 90 detik), lalu membuka browser bawaan.
// Dipakai oleh lanjutan\2-JALANKAN-NODE-RED.bat dan menu MULAI.bat (L -> 7).
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let R = {};
try { R = JSON.parse(fs.readFileSync(path.join(ROOT, "rahasia.json"), "utf8")); } catch (e) {}
const port = R.ui_port || 1882;
const kunci = crypto.createHash("sha256").update(String(R.credential_secret || R.editor_password || "") + ":editor-lokal").digest("hex");

function siap() {
  return new Promise((res) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/settings", timeout: 2000 }, (r) => { r.resume(); res(true); });
    req.on("timeout", () => { req.destroy(); res(false); });
    req.on("error", () => res(false));
  });
}

(async () => {
  for (let i = 0; i < 90 && !(await siap()); i++) await new Promise((s) => setTimeout(s, 1000));
  const url = `http://127.0.0.1:${port}/?access_token=${kunci}`;
  // cmd "start" membuka browser bawaan; tanda & tidak ada di alamat ini
  spawn("cmd.exe", ["/c", "start", "\"\"", `"${url}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
})();
