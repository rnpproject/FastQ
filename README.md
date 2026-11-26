<p align="center">
  <img src="assets/branding/fastq-mark.png" alt="Logo FastQ POS" width="180">
</p>

<h1 align="center" style="font-weight: bold;">FastQ POS</h1>

<p align="center">
  Aplikasi kasir offline-first untuk toko ritel dan F&amp;B.
</p>

Pemilik dapat menambahkan beberapa toko dan mengatur toko yang dapat diakses setiap akun. Pemilik dan Admin dapat mengelola akun terdaftar, mengatur ulang password akun lain, serta mengubah akses outlet dalam lingkup outlet yang diizinkan. Setiap role dapat mengubah nama, email/nomor HP, foto profil, dan password sendiri dari halaman profil kasir.

<h2 align="center">Teknologi</h2>

<p align="center">
  <img src="assets/tech-badges/javascript.svg" height="28" alt="JavaScript" style="border-radius:6px;">
  <img src="assets/tech-badges/typescript.svg" height="28" alt="TypeScript" style="border-radius:6px;">
  <img src="assets/tech-badges/html5.svg" height="28" alt="HTML5" style="border-radius:6px;">
  <img src="assets/tech-badges/css3.svg" height="28" alt="CSS3" style="border-radius:6px;">
  <img src="assets/tech-badges/react.svg" height="28" alt="React" style="border-radius:6px;">
  <br>
  <img src="assets/tech-badges/nodejs.svg" height="28" alt="Node.js" style="border-radius:6px;">
  <img src="assets/tech-badges/vite.svg" height="28" alt="Vite" style="border-radius:6px;">
  <img src="assets/tech-badges/postgresql.svg" height="28" alt="PostgreSQL" style="border-radius:6px;">
  <img src="assets/tech-badges/capacitor.svg" height="28" alt="Capacitor" style="border-radius:6px;">
  <img src="assets/tech-badges/offline.svg" height="28" alt="Offline first" style="border-radius:6px;">
</p>
<p align="center">
Frontend dibangun dengan Vite/React, API berjalan pada Node.js, dan PostgreSQL Supabase menyimpan akun serta data sinkronisasi. Data kerja POS juga disimpan terenkripsi pada perangkat/browser; database tidak menggantikan backup perangkat.
</p>

## Production: VPS + Supabase

### 1. Siapkan Supabase

Ambil connection string dari **Supabase Dashboard → Connect** untuk project yang benar.

#### Buat role database

Di **SQL Editor** Supabase, jalankan sekali sebagai role `postgres`. Ganti kedua placeholder password dengan secret yang berbeda dan kuat; jangan commit nilai aslinya.

```sql
CREATE ROLE pos_app_runtime
  WITH LOGIN PASSWORD 'GANTI_PASSWORD_RUNTIME'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE pos_admin
  WITH LOGIN PASSWORD 'GANTI_PASSWORD_MIGRASI'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE postgres TO pos_app_runtime, pos_admin;
GRANT CREATE ON DATABASE postgres TO pos_admin;
CREATE SCHEMA IF NOT EXISTS public;
GRANT USAGE ON SCHEMA public TO pos_app_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO pos_admin;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Jalankan blok tersebut pada database aplikasi sebagai `postgres`. Sesuaikan nama database pada perintah `GRANT` jika bukan `postgres`. Jalankan `CREATE ROLE` hanya jika role belum ada. Jika role sudah ada dan hanya perlu mengganti password, gunakan `ALTER ROLE pos_app_runtime WITH PASSWORD 'PASSWORD_BARU';` atau `ALTER ROLE pos_admin WITH PASSWORD 'PASSWORD_BARU';`. Jangan memberikan membership ke role `postgres`, `service_role`, atau role istimewa Supabase.

`CREATE SCHEMA IF NOT EXISTS` menyiapkan schema `public` bila belum ada tanpa mencoba beralih menjadi `pos_admin`; grant setelahnya memberi role migrasi izin untuk membuat objek di schema itu. `pgcrypto` disiapkan lebih dulu sebagai `postgres` agar migrasi tidak bergantung pada izin role untuk memasang extension. Jangan membuat tabel aplikasi atau `schema_migrations` secara manual di SQL Editor.

Untuk database baru yang belum memiliki tabel aplikasi, jalankan `npm run db:migrate` dari komputer admin dengan `POS_MIGRATION_DATABASE_URL` milik `pos_admin`. Migrator memastikan schema `public` tersedia, membuat baseline schema versi 1, lalu menerapkan migrasi bernomor. Objek yang dibuat migrator dimiliki oleh role koneksi migrasi; role runtime diberi hak DML pada tabel dan sequence aplikasi, sementara `schema_migrations` dibatasi menjadi read-only.

Jika database sudah memiliki tabel FastQ yang dibuat oleh `postgres` (termasuk database yang sebelumnya dimigrasikan melalui SQL Editor), gunakan connection string role `postgres` sebagai `POS_MIGRATION_DATABASE_URL`. `pos_admin` tidak otomatis menjadi pemilik objek lama; grant `CREATE` pada database/schema tidak memberinya hak untuk memberikan grant pada tabel tersebut atau menjalankan `ALTER`/`DROP`. Migrasi harus memakai role pemilik objek. Jangan menambahkan membership ke role istimewa atau mengubah ownership objek Supabase/extension hanya untuk mengatasi error ini.

Ambil connection string dari **Connect** untuk masing-masing role dan pilih pooler **Session mode** (port `5432`) jika VPS tidak mendukung koneksi IPv6 langsung. Connection string pooler biasanya memakai nama login `nama_role.project_ref`; salin format persis yang ditampilkan dashboard.

Panduan resmi: [Postgres Roles](https://supabase.com/docs/guides/database/postgres/roles) dan [izin migrasi pada database Supabase](https://supabase.com/kb/troubleshooting/resolving-permission-denied-for-database-postgres-during-migrations-78f33a).

- `DATABASE_URL` adalah koneksi runtime role terbatas (`pos_app_runtime`).
- `POS_MIGRATION_DATABASE_URL` hanya digunakan di komputer admin: pakai `pos_admin` untuk schema baru yang objeknya dibuat oleh role itu, atau pemilik objek (biasanya `postgres`) untuk schema yang sudah ada. Jangan pasang URL migrasi ini di VPS atau environment aplikasi.
- Set `PGSSLMODE=verify-full` dan `PGSSLROOTCERT` ke file root CA PEM Supabase dari dashboard. Jangan menonaktifkan validasi sertifikat.
- Dari mesin admin, siapkan environment lalu jalankan `npm run db:migrate`. Sesudah migrasi, `npm run db:status` memastikan role runtime, TLS, dan versi skema siap. Migrasi dijalankan sebelum merilis aplikasi baru.
- Jika migrasi berhasil tetapi `db:status` melaporkan `sync_schema_incomplete` atau `schema_migrations_unavailable`, pastikan `DATABASE_URL` memakai role runtime pada project dan database yang sama dengan `POS_MIGRATION_DATABASE_URL`. Nama database `postgres` saja tidak menjamin kedua URL menuju project yang sama.

Jangan menaruh connection string atau password database di Git, tiket, atau chat. Simpan environment produksi dengan izin baca terbatas. Password dalam URL harus di-URL-encode bila mengandung karakter khusus.

### 2. Build di VPS

Pasang Node.js 22.12 atau lebih baru dan Git. Buat direktori deployment milik user khusus aplikasi, lalu:

```sh
git clone <URL-REPOSITORY> /opt/fastq-pos
cd /opt/fastq-pos
npm ci
npm run build
npm prune --omit=dev
```

Build menjalankan pemeriksaan TypeScript dan format, membuat `public/` dari aset aplikasi, lalu membuat frontend production pada `dist/`. Setelah build selesai, runtime Node hanya memerlukan dependency produksi. Jangan menghapus `public/` atau `dist/` setelah build.

Simpan environment di `/etc/fastq-pos/fastq-pos.env` dengan pemilik root dan mode `0600`. `.env.example` mencantumkan variabel aplikasi; isi `DATABASE_URL` dengan runtime role, serta buat secret acak berbeda untuk `POS_SESSION_SECRET` dan `POS_API_TOKEN`. Tambahkan `POS_TOTP_ENCRYPTION_KEY` (64 karakter hex) hanya jika TOTP digunakan. Di production, aplikasi otomatis mempercayai header reverse proxy dan memakai cookie secure; mode development menonaktifkan keduanya. Jangan sertakan `POS_MIGRATION_DATABASE_URL` pada server aplikasi.

Contoh `/etc/systemd/system/fastq-pos.service` (sesuaikan user dan path):

```ini
[Unit]
Description=FastQ POS
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fastq-pos
Group=fastq-pos
WorkingDirectory=/opt/fastq-pos
EnvironmentFile=/etc/fastq-pos/fastq-pos.env
Environment=HOST=127.0.0.1
Environment=PORT=4173
ExecStart=/usr/bin/node /opt/fastq-pos/server/index.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Aktifkan dengan `sudo systemctl daemon-reload && sudo systemctl enable --now fastq-pos`. Node mendengarkan `127.0.0.1:4173`; jangan buka port itu ke internet.

Contoh konfigurasi Nginx di server HTTPS:

```nginx
client_max_body_size 21m;
location / {
    proxy_pass http://127.0.0.1:4173;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Gunakan sertifikat HTTPS valid dan buka hanya SSH, HTTP, dan HTTPS di firewall. `/` adalah landing page, `/pos` adalah kasir, dan `/dashboard` adalah ringkasan penjualan. `/api/health/live` memeriksa proses; `/api/health` memeriksa database.

Printer LAN dikonfigurasi dari kasir saat memilih **LAN**. Masukkan IP privat printer, port raw ESC/POS (umumnya `9100`), dan token API server. Pengaturan disimpan terenkripsi pada perangkat. Server harus berada pada jaringan yang dapat menjangkau printer; untuk VPS publik, gunakan USB/Bluetooth di perangkat kasir atau printer jaringan yang dapat dijangkau secara privat oleh server.

### 3. Rilis dan operasi

```sh
cd /opt/fastq-pos
git pull --ff-only
npm ci
npm run build
npm prune --omit=dev
sudo systemctl restart fastq-pos
curl --fail https://<DOMAIN>/api/health/live
curl --fail https://<DOMAIN>/api/health
```

Jalankan `npm run db:status` dari mesin admin yang memiliki `DATABASE_URL` runtime untuk diagnosis. Untuk perubahan skema, jalankan migrasi dari mesin admin sebelum mengalihkan aplikasi ke versi baru. Server menolak API saat role runtime terlalu berhak, database tidak tersedia, atau skema tertinggal.

Gunakan backup otomatis dan retensi sesuai paket Supabase. Tinjau [dokumentasi backup Supabase](https://supabase.com/docs/guides/platform/backups); retensi harian dan PITR bergantung pada paket/add-on. Jadwalkan uji restore ke project staging, termasuk pemeriksaan login, transaksi, dan sinkronisasi. Backup database tidak mencakup snapshot POS lokal di perangkat kasir.

## Pengembangan lokal

```sh
npm ci
npm run dev:all
```

Buka `http://localhost:5173`. `dev:all` menjalankan API di port 4173 dan Vite pada port 5173. Untuk web hasil build: `npm run build && npm start`, lalu buka `http://localhost:4173`. `.env.example` adalah templat environment; isi `.env` lokal dengan database pengembangan. Jangan jalankan migrasi produksi tanpa meninjau perubahan.

Gunakan `npm run format` untuk merapikan source dan `npm run format:check` untuk memeriksa format. `npm run build` menjalankan pemeriksaan format dan TypeScript sebelum membuat aset production.

Jalankan `npm test` untuk seluruh tes. Untuk memeriksa tipe secara terpisah, gunakan `npm run typecheck`.

### Build aplikasi Android

Gunakan Windows atau Linux yang sudah memasang Node.js 22.12 atau lebih baru, Android Studio, Android SDK Platform, dan build-tools yang sesuai dengan Gradle project. Android Studio juga menyertakan JDK yang direkomendasikan; jika memakai JDK terpisah, pastikan `JAVA_HOME` mengarah ke JDK yang kompatibel dengan Gradle.

Untuk Gradle 8.14.3 dan Android Gradle Plugin 8.13.0, gunakan JDK 21. JDK 26 menghasilkan error `Unsupported class file major version 70` dan tidak kompatibel dengan kombinasi Gradle/AGP saat ini.

Sebelum build rilis, pastikan aplikasi memakai URL API produksi yang benar. Build Android publik sebaiknya memakai aset lokal bundel (tanpa `server.url`) agar fix JavaScript ikut terbawa di APK. Set `VITE_API_BASE_URL` ke domain backend HTTPS saat build:

```sh
# PowerShell
$env:VITE_API_BASE_URL='https://pos.example.com'
npm run build
npx cap sync android
```

Gunakan URL domain produksi yang dapat dibuka dengan HTTPS. Jangan memasukkan `/api` pada `VITE_API_BASE_URL` karena aplikasi tetap memanggil path `/api/...` sendiri. Untuk pengujian lokal, gunakan alamat jaringan perangkat menuju server, misalnya `http://192.168.1.10:4173`, dan pastikan server mendengarkan pada alamat jaringan.

`server.url` di [capacitor.config.ts](capacitor.config.ts) sebaiknya hanya dipakai untuk live-reload/dev. Jangan gunakan URL preview sementara untuk build publish, karena aplikasi akan memuat JavaScript remote dan update fix lokal tidak ikut sampai remote di-deploy.

Sinkronkan web build dan proyek native:

```sh
npm ci
npm run build
npx cap sync android
```

Perintah `npm run cap:sync` juga dapat dipakai karena script tersebut menjalankan `npm run build && cap sync`.

Untuk membuka Android Studio:

```sh
npm run android:open
```

Dari Android Studio, pilih **Build > Build Bundle(s) / APK(s)** atau jalankan dari terminal:

```sh
cd android

# APK debug untuk pengujian
./gradlew assembleDebug

# APK release tanpa keystore
./gradlew assembleRelease

# Android App Bundle untuk Google Play
./gradlew bundleRelease
```

Pada Windows PowerShell gunakan `.\gradlew.bat assembleDebug`, `.\gradlew.bat assembleRelease`, atau `.\gradlew.bat bundleRelease`.

Android Studio tidak wajib. Build dapat dijalankan sepenuhnya dari command line selama JDK dan Android SDK/command-line tools sudah terpasang.

Pasang JDK yang kompatibel dengan Gradle, Android SDK Platform, build-tools, dan `cmdline-tools`. Setelah itu atur environment pada Windows:

```powershell
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.13.1"
$env:ANDROID_HOME = "C:\Users\$env:USERNAME\AppData\Local\Android\Sdk"
$env:Path = "$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:Path"

java -version
javac -version
adb version
sdkmanager --list
```

Pastikan `java -version` dan `javac -version` menampilkan JDK 21. Untuk menjaga JDK ini sebagai JAVA_HOME permanen pada Windows, buka **System Properties > Environment Variables** atau jalankan PowerShell administrator:

```powershell
[Environment]::SetEnvironmentVariable(
  'JAVA_HOME',
  'C:\Program Files\Microsoft\jdk-21.0.13.1',
  'User'
)
```

Buka terminal baru setelah mengubah `JAVA_HOME`. Jika `JAVA_HOME` lama masih dipakai, hentikan daemon Gradle lama lalu ulangi build:

```powershell
cd android
.\gradlew.bat --stop
.\gradlew.bat assembleDebug
```

Uji hanya satu environment terminal baru, lalu sinkronkan dan bangun dari direktori repository:

```powershell
npm ci
npm run build
npx cap sync android
cd android
.\gradlew.bat assembleDebug
```

Build tanpa Android Studio tidak memerlukan emulator atau Android Studio IDE. Emulator tetap hanya diperlukan untuk pengujian UI otomatis/interaktif. Untuk pemeriksaan APK pada perangkat, aktifkan USB debugging lalu pasang dengan:

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Perintah tersebut dijalankan dari direktori `android`. Jalankan `adb devices` sebelum instalasi untuk memastikan perangkat terlihat.

Untuk rilis Play Store atau distribusi release:

1. Buat upload keystore yang aman, jangan commit file keystore atau password ke Git.
2. Isi `keystoreProperties` atau signing config pada `android/app/build.gradle`, lalu jalankan bundle release.
3. Naikkan `versionCode` dan `versionName` di `android/app/build.gradle` untuk setiap build yang dipublikasikan.
4. Uji APK/AAB pada perangkat nyata untuk login, sinkronisasi, lokasi, SQLite, barcode, dan notifikasi.
5. Jangan menjalankan migration database dari aplikasi Android; migrasi tetap dijalankan dari komputer admin dengan `POS_MIGRATION_DATABASE_URL`.

Output build:

- Debug APK: `android/app/build/outputs/apk/debug/app-debug.apk`
- Release APK: `android/app/build/outputs/apk/release/app-release.apk`
- Release AAB: `android/app/build/outputs/bundle/release/app-release.aab`

## Fitur

- POS menyimpan transaksi dan katalog terakhir secara lokal agar transaksi tetap dapat dilakukan saat offline. Event tersimpan dalam antrean dan disinkronkan saat koneksi kembali tersedia. Jika transaksi offline menyebabkan stok melewati batas, saldo negatif disinkronkan dan ditampilkan sebagai konflik stok.
- Pengelolaan produk dan varian, stok, impor/ekspor CSV, serta impor produk Excel `.xlsx` dengan template. Template berisi SKU, nama produk, kategori, harga jual, modal, dan stok. SKU serta nama yang sama memperbarui stok, harga jual, dan modal; SKU yang sama dengan nama berbeda akan diberi akhiran `-D` (atau akhiran unik bila diperlukan).
- Shift dan pergerakan kas, absensi, refund, persetujuan berdasarkan role, struk, barcode, serta dukungan printer browser/native.
- Dashboard pemilik dan laporan. Daftar transaksi laporan menampilkan lima transaksi per halaman dan diperbarui otomatis saat halaman sedang dibuka.
- Service worker mendukung shell kasir offline. Pembaruan aplikasi diterapkan setelah pengguna memilih untuk memperbarui.
- Tindakan **Keluar & hapus data perangkat** menyinkronkan data tertunda sebelum menghapusnya. Jika sinkronisasi gagal atau masih ada event/masalah, data tidak dihapus. Jika tidak ada data tertunda, data perangkat langsung dihapus lalu sesi keluar.

## Struktur proyek

```text
.
├── app/
│   ├── index.html                 # Shell aplikasi web
│   ├── src/                       # Frontend React: routing, halaman, dan native bridge
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── pages/
│   └── pos/                       # Antarmuka dan runtime POS
│       ├── index.html
│       ├── runtime.js             # State lokal, transaksi, antrean, dan sinkronisasi
│       └── product-xlsx.js        # Pembaca Excel dan pembuat template
├── assets/                        # Branding dan font
├── android/                       # Proyek native Capacitor Android
├── db/
│   ├── schema.sql                 # Baseline skema database
│   └── migrations/                # Migrasi skema berurutan
├── scripts/                       # Build aset, migrasi, pemeliharaan, dan tes
├── server/                        # API Node.js, autentikasi, dan handler domain
├── shared/                        # Utilitas dan aturan domain browser/server
├── styles/                        # Design system, shell, dan utilitas CSS
├── public/                        # Aset statis hasil persiapan build
├── dist/                          # Hasil build web production
├── sw.js                          # Service worker sumber
├── package.json
└── README.md
```

Frontend React berada di `app/src/`; halaman kasir dan runtime POS berada di `app/pos/`. Backend ada di `server/`, sedangkan aturan domain yang digunakan browser maupun server ada di `shared/`. Build menyiapkan aset pada `public/`, lalu Vite menghasilkan rilis di `dist/`. Keduanya adalah direktori generated—jangan mengedit isinya langsung. Sumber gaya dan detail pipeline ada di [styles/README.md](styles/README.md).

## Environment

Lihat [.env.example](.env.example). `DATABASE_URL`, secret sesi, dan token API wajib. `PGSSLMODE=verify-full` dan CA Supabase direkomendasikan untuk koneksi managed PostgreSQL.
