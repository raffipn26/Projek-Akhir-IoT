// Membuat 2-node-red/data/flows.json dan flows_cred.json (dijalankan oleh pengembang, bukan oleh pengguna).
const fs = require("fs");
const path = require("path");
const OUT = path.join(__dirname, "..", "2-node-red", "data");

const ID = (s) => s; // id tetap agar mudah dirujuk
const DEV = "Absensi-01";

// ---------------------------------------------------------------- fungsi
const F_VALIDASI = `// Event dari ESP32 (topik absensi/<id>/event)
const p = msg.payload;
if (!p || typeof p !== 'object' || typeof p.ts !== 'number' || typeof p.status !== 'string') {
    node.warn('Event ditolak, format salah: ' + JSON.stringify(p));
    return null;
}
if (p.kartu && !/^[0-9a-f]{16}$/.test(p.kartu)) {
    node.warn('Event ditolak, hash kartu tidak valid: ' + p.kartu);
    return null;
}
const id = msg.topic.split('/')[1];                       // absensi-01
msg.perangkat = id;
msg.namaPerangkat = id.replace(/^./, c => c.toUpperCase()); // Absensi-01 (nama device di ThingsBoard)
node.status({ fill: 'green', shape: 'dot', text: p.status + ' ' + (p.nama || '') });
return msg;`;

const F_STATUS_HARIAN = `// Simpan status hari ini per karyawan (scan masuk pertama, scan pulang terakhir)
const WIB = 7 * 3600 * 1000;
const p = msg.payload;
const d = new Date(p.ts + WIB);
const tanggal = d.toISOString().slice(0, 10);
const menit = d.getUTCHours() * 60 + d.getUTCMinutes();
const keMenit = s => { const m = /^(\\d\\d):(\\d\\d)$/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };

const harian = global.get('harian') || {};

// Tombol BOOT ESP32 ditahan 3 detik (mode uji): data absen hari itu dikosongkan,
// status tutup hari dilepas agar rekap dihitung lagi pada batas absen.
if (p.status === 'RESET_UJI') {
    delete harian[tanggal];
    global.set('harian', harian);
    for (const k of ['tanggalDitutup', 'tutupOtomatis']) {
        const g = global.get(k) || {};
        delete g[tanggal];
        global.set(k, g);
    }
    node.warn('RESET UJI dari tombol BOOT: data absen ' + tanggal + ' dikosongkan');
    node.status({ fill: 'yellow', shape: 'dot', text: 'reset uji ' + tanggal });
    msg.tanggal = tanggal;
    return [msg, null];
}

const hari = harian[tanggal] || (harian[tanggal] = {});
let berubah = false;
if (p.kartu) {
    const r = hari[p.kartu] || { nama: p.nama || '', masuk: null, pulang: null };
    if (p.nama) r.nama = p.nama;
    if (p.status === 'MASUK_TEPAT' || p.status === 'MASUK_TELAT') {
        if (r.masuk === null || menit < r.masuk) { r.masuk = menit; berubah = true; }
    } else if (p.status === 'PULANG' || p.status === 'PULANG_CEPAT') {
        const m = keMenit(p.masuk);
        if (r.masuk === null && m !== null) { r.masuk = m; berubah = true; }
        if (r.pulang === null || menit > r.pulang) { r.pulang = menit; berubah = true; }
    } else if (p.status === 'LUPA_ABSEN_MASUK') {
        if (r.pulang === null || menit > r.pulang) { r.pulang = menit; berubah = true; }
    }
    hari[p.kartu] = r;
}
// simpan maksimal 40 hari terakhir
const batas = new Date(Date.now() + WIB - 40 * 86400000).toISOString().slice(0, 10);
for (const t of Object.keys(harian)) if (t < batas) delete harian[t];
global.set('harian', harian);
msg.tanggal = tanggal;

// data antrian offline yang datang setelah hari itu ditutup -> rekap dihitung ulang
const ditutup = global.get('tanggalDitutup') || {};
const ulang = (berubah && ditutup[tanggal]) ? { topic: 'hitung-ulang', tanggal: tanggal } : null;
return [msg, ulang];`;

const F_FORMAT_EVENT = `// Ubah ke format Gateway API ThingsBoard
const p = msg.payload;
const dev = msg.namaPerangkat;
const values = Object.assign({}, p);
delete values.ts;
const keluar = [{ topic: 'v1/gateway/telemetry', payload: { [dev]: [{ ts: p.ts, values: values }] } }];
if (p.status === 'TIDAK_TERDAFTAR') {
    // muncul di Client attributes perangkat: hash ini yang didaftarkan admin
    const waktu = new Date(p.ts + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
    keluar.push({ topic: 'v1/gateway/attributes', payload: { [dev]: { kartu_baru: p.kartu, kartu_baru_waktu: waktu } } });
}
return [keluar];`;

const F_RINGKASAN = `// Ringkasan 30 detik dari ESP32 -> telemetri ThingsBoard
const p = msg.payload;
if (!p || typeof p !== 'object') return null;
const id = msg.topic.split('/')[1];
const dev = id.replace(/^./, c => c.toUpperCase());
const values = Object.assign({}, p);
const ts = typeof p.ts === 'number' && p.ts > 1700000000000 ? p.ts : Date.now();
delete values.ts;
return { topic: 'v1/gateway/telemetry', payload: { [dev]: [{ ts: ts, values: values }] } };`;

const F_STATUS_PERANGKAT = `// online/offline dari ESP32 (last will) -> client attribute
const id = msg.topic.split('/')[1];
const dev = id.replace(/^./, c => c.toUpperCase());
const s = String(msg.payload);
node.status({ fill: s === 'online' ? 'green' : 'red', shape: 'dot', text: dev + ' ' + s });
const waktu = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
return { topic: 'v1/gateway/attributes', payload: { [dev]: { status_perangkat: s, status_waktu: waktu } } };`;

const F_WAKTU = `// Jam laptop dikirim ke ESP32 (cadangan bila ESP32 tidak bisa NTP)
msg.topic = 'absensi/waktu';
msg.payload = String(Math.floor(Date.now() / 1000));
return msg;`;

const F_TUTUP_HARI = `// Rekap final per karyawan: jam kerja normal, lembur, terlambat, lupa absen pulang, tidak hadir
const WIB = 7 * 3600 * 1000;
const DEV = '${DEV}';
const J = Object.assign({
    buka_absen: '07:00', jam_masuk: '08:00', istirahat: '12:00-13:00', jam_pulang: '17:00',
    min_lembur: 30, blok_lembur: 30, maks_lembur: 240, maks_lembur_minggu: 1080, hari_kerja: '1-5'
}, global.get('jadwal') || {});
const mnt = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const jam = x => x === null || x === undefined ? '-' : String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
const durasi = x => Math.floor(x / 60) + 'j ' + String(x % 60).padStart(2, '0') + 'm';
const [IS, IE] = String(J.istirahat).split('-').map(mnt);
const JM = mnt(J.jam_masuk), JP = mnt(J.jam_pulang);
const irisan = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

function hitungHarian(masuk, pulang) {
    const wajib = JP - JM - (IE - IS);                          // 480 menit = 8 jam
    if (masuk == null && pulang == null) return { status: 'TIDAK_HADIR', normal: 0, lembur: 0, telat: 0, cepat: 0 };
    if (masuk == null) return { status: 'TIDAK_LENGKAP', normal: 0, lembur: 0, telat: 0, cepat: 0 };
    let status = 'HADIR';
    if (pulang == null) { pulang = JP; status = 'LUPA_ABSEN_PULANG'; }   // dianggap pulang normal, tanpa lembur
    const batasLembur = JP + Number(J.maks_lembur);             // 21:00
    const mulai = Math.max(masuk, JM);                          // datang lebih awal tidak dihitung
    const akhir = Math.min(pulang, batasLembur);
    const kerja = Math.max(0, akhir - mulai) - irisan(mulai, akhir, IS, IE);
    const telat = Math.max(0, masuk - JM);
    const cepat = Math.max(0, JP - pulang);
    // lembur = waktu setelah jam pulang, hanya bagian yang melebihi jam wajib
    const lemburMentah = status === 'LUPA_ABSEN_PULANG' ? 0 : Math.min(Math.max(0, kerja - wajib), Math.max(0, akhir - JP));
    const lembur = lemburMentah < J.min_lembur ? 0 : Math.floor(lemburMentah / J.blok_lembur) * J.blok_lembur;
    const normal = Math.min(Math.max(0, kerja), wajib);
    if (status === 'HADIR') status = cepat > 0 ? 'PULANG_CEPAT' : (telat > 0 ? 'TERLAMBAT' : 'TEPAT_WAKTU');
    return { status, normal, lembur, telat, cepat };
}

// tanggal yang ditutup: otomatis (batas absen) & hitung ulang -> msg.tanggal, tombol uji -> hari ini
let tanggal = msg.tanggal;
if (!tanggal) tanggal = new Date(Date.now() + WIB).toISOString().slice(0, 10);
const hariKe = t => { const d = new Date(t + 'T00:00:00Z').getUTCDay(); return d === 0 ? 7 : d; };
const hariKerja = new Set();
String(J.hari_kerja).split(',').forEach(bag => {
    const [a, b] = bag.split('-').map(Number);
    for (let i = a; i <= (b || a); i++) hariKerja.add(i);
});
const isHariKerja = hariKerja.has(hariKe(tanggal));

const karyawan = global.get('karyawan') || {};
const harian = (global.get('harian') || {})[tanggal] || {};
const rekap = global.get('rekap') || {};
const senin = (() => { const d = new Date(tanggal + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - (hariKe(tanggal) - 1)); return d.toISOString().slice(0, 10); })();

const base = Date.parse(tanggal + 'T23:59:00+07:00');
const baris = [];
const hasilHari = {};
const total = { hadir: 0, terlambat: 0, tidak_hadir: 0, lupa_pulang: 0, lembur: 0, normal: 0 };
let i = 0;
for (const h of new Set([...Object.keys(karyawan), ...Object.keys(harian)])) {
    const rec = harian[h] || { masuk: null, pulang: null };
    const k = karyawan[h];
    const nama = (typeof k === 'string' ? k : (k && k.nama)) || rec.nama || h;
    if (!k && rec.masuk == null && rec.pulang == null) continue;
    const r = hitungHarian(rec.masuk, rec.pulang);
    if (!isHariKerja && r.status === 'TIDAK_HADIR') continue;     // hari libur bukan alpa
    // batas lembur mingguan (PP 35/2021: maks 18 jam)
    let sebelum = 0;
    for (const t of Object.keys(rekap)) if (t >= senin && t < tanggal && rekap[t][h]) sebelum += rekap[t][h].lembur_mentah || 0;
    const lemburMinggu = sebelum + r.lembur;
    const lemburDihitung = Math.max(0, Math.min(r.lembur, Number(J.maks_lembur_minggu) - sebelum));
    hasilHari[h] = { nama, status: r.status, lembur_mentah: r.lembur, lembur: lemburDihitung, normal: r.normal };

    if (r.status !== 'TIDAK_HADIR' && r.status !== 'TIDAK_LENGKAP') total.hadir++;
    if (r.telat > 0) total.terlambat++;
    if (r.status === 'TIDAK_HADIR') total.tidak_hadir++;
    if (r.status === 'LUPA_ABSEN_PULANG') total.lupa_pulang++;
    total.lembur += lemburDihitung;
    total.normal += r.normal;
    i++;
    baris.push({ ts: base + i, values: {
        rekap_tanggal: tanggal, rekap_nama: nama, rekap_kartu: h, rekap_status: r.status,
        rekap_masuk: jam(rec.masuk), rekap_pulang: r.status === 'LUPA_ABSEN_PULANG' ? '-' : jam(rec.pulang),
        rekap_normal_menit: r.normal, rekap_lembur_menit: lemburDihitung, rekap_telat_menit: r.telat, rekap_cepat_menit: r.cepat,
        rekap_kerja_teks: durasi(r.normal), rekap_lembur_teks: durasi(lemburDihitung), lembur_minggu_menit: lemburMinggu
    } });
}
baris.push({ ts: base, values: {
    harian_tanggal: tanggal, harian_hadir: total.hadir, harian_terlambat: total.terlambat,
    harian_tidak_hadir: total.tidak_hadir, harian_lupa_pulang: total.lupa_pulang,
    harian_total_lembur_menit: total.lembur, harian_total_normal_menit: total.normal
} });

rekap[tanggal] = hasilHari;
const ditutup = global.get('tanggalDitutup') || {};
ditutup[tanggal] = true;
const batas = new Date(Date.now() + WIB - 40 * 86400000).toISOString().slice(0, 10);
for (const t of Object.keys(rekap)) if (t < batas) delete rekap[t];
for (const t of Object.keys(ditutup)) if (t < batas) delete ditutup[t];
global.set('rekap', rekap);
global.set('tanggalDitutup', ditutup);

node.status({ fill: 'blue', shape: 'dot', text: tanggal + ': ' + i + ' karyawan, ' + total.hadir + ' hadir' });
return { topic: 'v1/gateway/telemetry', payload: { [DEV]: baris } };`;

const F_CEK_BATAS = `// Dicek tiap 60 detik: begitu jam WIB mencapai batas absen (bawaan 21:00 = jam pulang + lembur maks),
// rekap hari ini ditutup otomatis. Karyawan yang belum absen pulang -> LUPA_ABSEN_PULANG
// (pulang dihitung 17:00, lembur 0). Hari sebelumnya yang belum ditutup (Node-RED mati) ikut ditutup.
const WIB = 7 * 3600 * 1000;
const J = Object.assign({ jam_pulang: '17:00', maks_lembur: 240 }, global.get('jadwal') || {});
const mnt = s => { const m = /^(\\d{1,2}):(\\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const batas = mnt(J.batas_absen) ?? (mnt(J.jam_pulang) + Number(J.maks_lembur));
const jam = x => String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');
const now = new Date(Date.now() + WIB);
const hariIni = now.toISOString().slice(0, 10);
const menit = now.getUTCHours() * 60 + now.getUTCMinutes();
const sudah = global.get('tutupOtomatis') || {};
const keluar = [];
for (const t of Object.keys(global.get('harian') || {}).sort()) {
    if (t < hariIni && !sudah[t]) { sudah[t] = true; keluar.push({ topic: 'otomatis', tanggal: t }); }
}
if (menit >= batas && !sudah[hariIni]) { sudah[hariIni] = true; keluar.push({ topic: 'otomatis', tanggal: hariIni }); }
const batasLama = new Date(Date.now() + WIB - 40 * 86400000).toISOString().slice(0, 10);
for (const t of Object.keys(sudah)) if (t < batasLama) delete sudah[t];
global.set('tutupOtomatis', sudah);
node.status(sudah[hariIni]
    ? { fill: 'blue', shape: 'dot', text: hariIni + ' sudah ditutup (batas ' + jam(batas) + ')' }
    : { fill: 'green', shape: 'ring', text: 'tutup otomatis pukul ' + jam(batas) });
if (!keluar.length) return null;
return [keluar];`;

const F_CONFIG = `// Data karyawan & jadwal dari ThingsBoard (shared attributes) -> simpan -> kirim ke ESP32
const DEV = '${DEV}';
const p = msg.payload;
if (!p || typeof p !== 'object') return null;
let data = null;
if (msg.topic === 'v1/gateway/attributes') {
    if (p.device !== DEV) return null;
    data = p.data;
} else {                                     // v1/gateway/attributes/response
    if (p.device && p.device !== DEV) return null;
    data = p.values || p.value || null;
}
if (!data || typeof data !== 'object') return null;
const baca = v => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { node.warn('Atribut bukan JSON yang valid: ' + v); return undefined; }
};
let ada = false;
if (data.karyawan !== undefined) { const k = baca(data.karyawan); if (k && typeof k === 'object') { global.set('karyawan', k); ada = true; } }
if (data.jadwal !== undefined) { const j = baca(data.jadwal); if (j && typeof j === 'object') { global.set('jadwal', j); ada = true; } }
if (!ada) return null;
const karyawan = global.get('karyawan') || {};
node.status({ fill: 'green', shape: 'dot', text: Object.keys(karyawan).length + ' karyawan diterima' });
return { topic: 'absensi/absensi-01/config', payload: { karyawan: karyawan, jadwal: global.get('jadwal') || {} }, retain: true, qos: 1 };`;

const F_CONFIG_TERSIMPAN = `// Saat Node-RED baru menyala: kirim lagi data karyawan & jadwal yang tersimpan (retained)
const karyawan = global.get('karyawan');
if (!karyawan) { node.status({ fill: 'yellow', shape: 'ring', text: 'belum ada data dari ThingsBoard' }); return null; }
node.status({ fill: 'green', shape: 'dot', text: Object.keys(karyawan).length + ' karyawan' });
return { topic: 'absensi/absensi-01/config', payload: { karyawan: karyawan, jadwal: global.get('jadwal') || {} }, retain: true, qos: 1 };`;

const F_MINTA_ATRIBUT = `// Saat tersambung ke ThingsBoard: umumkan perangkat lalu minta data karyawan & jadwal
if (msg.status && msg.status.fill && msg.status.fill !== 'green') return null;
const DEV = '${DEV}';
return [[
    { topic: 'v1/gateway/connect', payload: { device: DEV, type: 'default' } },
    { topic: 'v1/gateway/attributes/request', payload: { id: Math.floor(Math.random() * 100000), device: DEV, client: false, keys: ['karyawan', 'jadwal'] } }
]];`;

// ---------------------------------------------------------------- node
const nodes = [];
const tab = (id, label, info) => nodes.push({ id, type: "tab", label, disabled: false, info: info || "" });
const add = (o) => { nodes.push(o); return o; };
const fn = (id, z, name, func, x, y, wires, outputs = 1) =>
  add({ id, type: "function", z, name, func, outputs, timeout: 0, noerr: 0, initialize: "", finalize: "", libs: [], x, y, wires });
const comment = (id, z, name, info, x, y) => add({ id, type: "comment", z, name, info: info || "", x, y, wires: [] });
const debug = (id, z, name, x, y, active = false) =>
  add({ id, type: "debug", z, name, active, tosidebar: true, console: false, tostatus: false, complete: "true", targetType: "full", statusVal: "", statusType: "auto", x, y, wires: [] });
const mqttIn = (id, z, name, topic, broker, datatype, x, y, wires) =>
  add({ id, type: "mqtt in", z, name, topic, qos: "1", datatype, broker, nl: false, rap: true, rh: 0, inputs: 0, x, y, wires });
const mqttOut = (id, z, name, broker, x, y) =>
  add({ id, type: "mqtt out", z, name, topic: "", qos: "1", retain: "", respTopic: "", contentType: "", userProps: "", correl: "", expiry: "", broker, x, y, wires: [] });
const inject = (id, z, name, x, y, wires, opt = {}) =>
  add({ id, type: "inject", z, name, props: [{ p: "payload" }, { p: "topic", vt: "str" }], repeat: opt.repeat || "", crontab: opt.crontab || "",
        once: !!opt.once, onceDelay: opt.onceDelay || 0.1, topic: opt.topic || "", payload: "", payloadType: "date", x, y, wires });

// konfigurasi (global)
add({ id: "tls_lokal", type: "tls-config", name: "TLS broker lokal (CA kelompok)", cert: "", key: "", ca: "${ABSENSI_CA_CRT}",
      certname: "", keyname: "", caname: "", servername: "", verifyservercert: true, alpnprotocol: "" });
add({ id: "tls_tb", type: "tls-config", name: "TLS ThingsBoard Cloud", cert: "", key: "", ca: "${ABSENSI_TB_CA}",
      certname: "", keyname: "", caname: "", servername: "", verifyservercert: true, alpnprotocol: "" });
const brokerBase = { autoConnect: true, usetls: true, protocolVersion: "4", keepalive: "60", cleansession: true, autoUnsubscribe: true,
  birthTopic: "", birthQos: "0", birthRetain: "false", birthPayload: "", birthMsg: {}, closeTopic: "", closeQos: "0", closeRetain: "false",
  closePayload: "", closeMsg: {}, willTopic: "", willQos: "0", willRetain: "false", willPayload: "", willMsg: {}, userProps: "", sessionExpiry: "" };
add({ id: "broker_lokal", type: "mqtt-broker", name: "Broker lokal (Aedes)", broker: "127.0.0.1", port: "8883", tls: "tls_lokal", clientid: "node-red-absensi", ...brokerBase });
add({ id: "broker_tb", type: "mqtt-broker", name: "ThingsBoard (Gateway Node-RED)", broker: "${TB_HOST}", port: "${TB_PORT}", tls: "tls_tb", clientid: "node-red-gateway-absensi", ...brokerBase });

// ---------------- Tab 1
const T1 = "tab_data";
tab(T1, "1. Data Absensi", "ESP32 -> broker Aedes -> validasi -> status harian -> ThingsBoard (Gateway API)");
comment("c1", T1, "ESP32 -> Node-RED -> ThingsBoard", "Broker MQTT TLS port 8883 berjalan di node Broker Absensi.\nUsername/password perangkat dan path sertifikat diambil dari rahasia.json lewat settings.js.", 220, 40);
add({ id: "aedes", type: "aedes broker", z: T1, name: "Broker Absensi (TLS 8883)", mqtt_port: "8883", mqtt_ws_bind: "port", mqtt_ws_port: "", mqtt_ws_path: "",
      cert: "${ABSENSI_BROKER_CRT}", key: "${ABSENSI_BROKER_KEY}", ca: "", certname: "", keyname: "", caname: "", persistence_bind: "memory", persist_to_file: true, dburl: "",
      usetls: true, x: 190, y: 100, wires: [["dbg_klien"], []] });
debug("dbg_klien", T1, "klien broker", 430, 100);
mqttIn("in_event", T1, "absensi/+/event", "absensi/+/event", "broker_lokal", "json", 160, 180, [["f_validasi"]]);
fn("f_validasi", T1, "Validasi event", F_VALIDASI, 370, 180, [["f_harian"]]);
fn("f_harian", T1, "Simpan status harian", F_STATUS_HARIAN, 580, 180, [["f_format", "dbg_event"], ["lo_ulang"]], 2);
add({ id: "lo_ulang", type: "link out", z: T1, name: "hitung ulang rekap", mode: "link", links: ["li_ulang"], x: 765, y: 220, wires: [] });
fn("f_format", T1, "Format Gateway API", F_FORMAT_EVENT, 800, 160, [["out_tb1"]]);
debug("dbg_event", T1, "event masuk", 790, 260, true);
mqttOut("out_tb1", T1, "ThingsBoard", "broker_tb", 1010, 160);
mqttIn("in_ringkasan", T1, "absensi/+/ringkasan", "absensi/+/ringkasan", "broker_lokal", "json", 170, 320, [["f_ringkasan"]]);
fn("f_ringkasan", T1, "Ringkasan 30 detik", F_RINGKASAN, 400, 320, [["out_tb1"]]);
mqttIn("in_status", T1, "absensi/+/status", "absensi/+/status", "broker_lokal", "utf8", 160, 380, [["f_status"]]);
fn("f_status", T1, "Status perangkat", F_STATUS_PERANGKAT, 390, 380, [["out_tb1"]]);
inject("inj_waktu", T1, "tiap 60 detik", 150, 460, [["f_waktu"]], { repeat: "60", once: true, onceDelay: 5 });
fn("f_waktu", T1, "Jam untuk ESP32", F_WAKTU, 360, 460, [["out_lokal1"]]);
mqttOut("out_lokal1", T1, "broker lokal", "broker_lokal", 560, 460);

// ---------------- Tab 2
const T2 = "tab_tutup";
tab(T2, "2. Tutup Hari", "Pada batas absen (bawaan 21:00) menghitung rekap final: jam kerja, lembur, lupa absen pulang (dihitung sampai 17:00, lembur 0), tidak hadir, lembur mingguan.");
comment("c2", T2, "Tutup hari otomatis pada batas absen (21:00 WIB)", "Batas diambil dari shared attribute jadwal.batas_absen (bawaan jam_pulang + maks_lembur = 21:00).\nTombol 'Tutup hari ini (uji)' dipakai saat demo agar tidak perlu menunggu.", 240, 40);
inject("inj_cek", T2, "tiap 60 detik", 140, 100, [["f_cek_batas"]], { repeat: "60", once: true, onceDelay: 10 });
fn("f_cek_batas", T2, "Cek batas absen", F_CEK_BATAS, 330, 100, [["f_tutup"]]);
inject("inj_uji", T2, "Tutup hari ini (uji)", 160, 160, [["f_tutup"]], { topic: "uji" });
add({ id: "li_ulang", type: "link in", z: T2, name: "hitung ulang rekap", links: ["lo_ulang"], x: 145, y: 220, wires: [["f_tutup"]] });
fn("f_tutup", T2, "Tutup hari (hitungHarian)", F_TUTUP_HARI, 410, 160, [["out_tb2", "dbg_rekap"]]);
mqttOut("out_tb2", T2, "ThingsBoard", "broker_tb", 650, 140);
debug("dbg_rekap", T2, "rekap harian", 660, 200, true);

// ---------------- Tab 3
const T3 = "tab_config";
tab(T3, "3. Konfigurasi", "Data karyawan & jadwal (shared attributes ThingsBoard) diteruskan ke ESP32 sebagai pesan retained.");
comment("c3", T3, "ThingsBoard -> Node-RED -> ESP32", "Admin mengubah shared attribute 'karyawan' atau 'jadwal' pada device Absensi-01.", 210, 40);
mqttIn("in_attr", T3, "v1/gateway/attributes", "v1/gateway/attributes", "broker_tb", "json", 170, 100, [["f_config"]]);
mqttIn("in_attr_resp", T3, "v1/gateway/attributes/response", "v1/gateway/attributes/response", "broker_tb", "json", 200, 160, [["f_config"]]);
fn("f_config", T3, "Karyawan & jadwal", F_CONFIG, 450, 130, [["out_lokal3", "dbg_config"]]);
mqttOut("out_lokal3", T3, "broker lokal (retain)", "broker_lokal", 690, 110);
debug("dbg_config", T3, "config", 660, 170, true);
inject("inj_start", T3, "saat mulai", 140, 240, [["f_config_simpan"]], { once: true, onceDelay: 5 });
fn("f_config_simpan", T3, "Kirim config tersimpan", F_CONFIG_TERSIMPAN, 390, 240, [["out_lokal3"]]);
add({ id: "st_tb", type: "status", z: T3, name: "status ThingsBoard", scope: ["in_attr"], x: 160, y: 320, wires: [["f_minta"]] });
inject("inj_minta", T3, "tiap 10 menit", 150, 380, [["f_minta"]], { repeat: "600", once: true, onceDelay: 15 });
fn("f_minta", T3, "Minta atribut", F_MINTA_ATRIBUT, 380, 350, [["out_tb3"]]);
mqttOut("out_tb3", T3, "ThingsBoard", "broker_tb", 580, 350);

fs.writeFileSync(path.join(OUT, "flows.json"), JSON.stringify(nodes, null, 2));

// kredensial berisi placeholder variabel lingkungan; nilai asli ada di rahasia.json (tidak ikut repo)
const cred = {
  aedes: { username: "${ABSENSI_MQTT_USER}", password: "${ABSENSI_MQTT_PASS}" },
  broker_lokal: { user: "${ABSENSI_MQTT_USER}", password: "${ABSENSI_MQTT_PASS}" },
  broker_tb: { user: "${TB_GATEWAY_TOKEN}", password: "" },
};
fs.writeFileSync(path.join(OUT, "flows_cred.json"), JSON.stringify(cred, null, 2));
console.log("flows.json:", nodes.length, "node");
