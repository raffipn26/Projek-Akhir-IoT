// Salin file ini menjadi secrets.h lalu isi. secrets.h TIDAK boleh diunggah ke GitHub.
#pragma once

// WiFi yang dipakai ESP32 (2,4 GHz). Paling mudah: Mobile Hotspot laptop Node-RED.
#define WIFI_SSID   "NAMA_WIFI"
#define WIFI_PASS   "PASSWORD_WIFI"

// Broker MQTT di Node-RED (laptop). Mobile Hotspot Windows selalu 192.168.137.1.
// Alamat ini HARUS sama dengan alamat yang dipakai saat membuat sertifikat.
#define MQTT_HOST   "192.168.137.1"
#define MQTT_PORT   8883

// Akun perangkat di broker Aedes (sama dengan username/password di node "Broker Absensi")
#define MQTT_USER   "absensi-01"
#define MQTT_PASS   "ISI_PASSWORD_PERANGKAT"

// Nama perangkat: dipakai di topik absensi/<DEVICE_ID>/...
#define DEVICE_ID   "absensi-01"
