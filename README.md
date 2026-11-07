# IDLIX for Android TV 🎬📺

<p align="center">
  <img width="520" src="https://cdn.abdilah.id/uploads/com.idlix.tv-preview.jpeg" alt="IDLIX TV Preview">
</p>

Aplikasi Android TV modern dan berperforma tinggi (**100% Native & Mandiri / Standalone**) untuk streaming film dan serial TV dari IDLIX dengan antarmuka Netflix-style Leanback.

Aplikasi ini **100% mandiri (tanpa perlu backend server terpisah)**. Seluruh logika katalog dan resolver pemutaran video HLS berjalan langsung di dalam aplikasi Android TV yang terhubung langsung ke **`https://z2.idlixku.com`**.

---

## 🌟 Fitur Unggulan

* **100% Standalone (Tanpa Backend Server)**:
  * Tidak memerlukan laptop menyala, VPS, Docker, Termux, atau server Node.js terpisah.
  * Aplikasi di Android TV langsung mengambil data dan menyelesaikan stream ke endpoint publik `https://z2.idlixku.com/`.
* **Bebas Iklan & Popup Judol**:
  * Menonton film dan serial dengan nyaman di layar lebar TV tanpa gangguan popup, banner, atau redirect iklan judi online seperti di web browser.
* **100% Native Architecture**:
  * Dibuat menggunakan **Kotlin** murni, **Jetpack Compose for TV** (`androidx.tv.material3`), dan **AndroidX Media3 (ExoPlayer)**.
  * Bebas WebView/Chromium di dalam APK sehingga ukuran aplikasi sangat ringan (~9–21 MB) dan hemat RAM (sangat lancar di TV Box berspesifikasi rendah/1GB RAM).
  * Menggunakan hardware decoder bawaan TV (`MediaCodec`) untuk pemutaran video halus tanpa stuttering.
* **Netflix-Style Leanback UI**:
  * Floating navigation sidebar dengan animasi overlay yang halus.
  * Billboard Hero dinamis dengan preview sinopsis dan tombol Putar Cepat.
  * Baris horizontal swimlane untuk Tren, Populer, Serial TV, dan Kategori Genre.
  * Fitur **Lanjutkan Menonton (Continue Watching)** dengan progress bar visual otomatis tersimpan di memori TV.
* **Native Playback & CDN Resolver**:
  * Menyelesaikan siklus streaming IDLIX (gate token, timer countdown, claim session, dan master playlist HLS) secara native di dalam Kotlin client.
  * Otomatis melestarikan token otorisasi CDN (`?t=...`) pada sub-playlist dan chunk segmen media (`.webp`, `.jpg`, `.js`, dll.).
* **Manajemen Subtitle & Integrasi SubDL**:
  * Otomatis memuat subtitle internal IDLIX (Bahasa Indonesia & English).
  * Dilengkapi pencarian dan pengunduhan subtitle alternatif via integrasi SubDL.com langsung dari player.
* **Pengaturan Fleksibel (In-App Settings)**:
  * URL sumber streaming dapat disesuaikan langsung dari menu Pengaturan di TV menggunakan remote D-pad jika domain IDLIX berganti di masa mendatang.

---

## 📁 Struktur Direktori

```
idlix-androidtv/
├── app/                                 # Modul Utama Aplikasi Android TV (Kotlin + Compose)
│   ├── src/main/java/com/idlix/tv/
│   │   ├── data/
│   │   │   ├── api/                     # Retrofit client & direct API headers
│   │   │   ├── local/                   # Penyimpanan riwayat tontonan lokal
│   │   │   ├── model/                   # Serializer & model data JSON
│   │   │   └── repository/              # IdlixRepository (Native stream resolver)
│   │   ├── ui/
│   │   │   ├── components/              # TvNavDrawer, TvMovieCard, TvHeroBillboard, dll.
│   │   │   ├── navigation/              # Navigation Host & rute halaman
│   │   │   ├── screens/                 # Beranda, Detail, Player, Pencarian, Pengaturan
│   │   │   └── theme/                   # Desain warna & tipografi TV Leanback
│   │   └── res/                         # String lokalisasi (Bahasa Indonesia & English)
│   └── build.gradle.kts
│
├── gradle/                              # Gradle wrapper & version catalogs
├── build.gradle.kts
├── settings.gradle.kts
├── gradle.properties
├── PANDUAN_INSTALASI_TV.md              # Panduan instalasi ramah pemula
├── webos/                               # Versi LG webOS (HTML5 + hls.js, paket IPK)
│   ├── README.md                        # Build & package dengan webOS CLI
│   └── …
└── README.md
```

### 📺 Versi LG webOS

Untuk TV LG (webOS), gunakan proyek di folder **[`webos/`](webos/README.md)**: antarmuka web yang berbicara ke API yang sama dan memutar HLS dengan **hls.js**. Lihat [`webos/README.md`](webos/README.md) untuk `npm install`, build, dan perintah `ares-package` / `ares-install`.

---

## 🚀 Panduan Pemasangan ke Android TV

Tersedia dua opsi pemasangan sesuai kebutuhan Anda:

### 🟢 Opsi 1: Untuk Pengguna Biasa (Praktis & Tanpa Koding)

> 📖 **Panduan Lengkap & Bergambar**: Lihat langkah-langkah di [**PANDUAN_INSTALASI_TV.md**](PANDUAN_INSTALASI_TV.md).

1. Unduh berkas APK (dari halaman [Releases](https://github.com/nesia26/idlix-androidtv/releases) atau salinan APK).
2. Kirim atau salin APK ke TV menggunakan salah satu metode:
   * **Lewat HP**: Menggunakan aplikasi gratis **Send Files to TV (SFTTV)** dari Google Play Store.
   * **Lewat Flashdisk (USB Drive)**: Salin APK ke flashdisk, tancapkan ke TV, dan buka dengan aplikasi File Manager di TV (misal: *File Commander* atau *AnExplorer*).
   * **Lewat Aplikasi Downloader**: Unduh langsung di TV menggunakan aplikasi **Downloader by AFTVnews**.
3. Klik file APK dan pilih **Install**.
4. Buka aplikasi di TV dan nikmati streaming film favorit Anda langsung tanpa setup server!

---

### 💻 Opsi 2: Untuk Pengembang / Developer (via ADB)

1. **Clone repository ini**:
   ```bash
   git clone https://github.com/nesia26/idlix-androidtv.git
   cd idlix-androidtv
   ```

2. **Kompilasi APK Debug / Release**:
   ```bash
   ./gradlew assembleDebug
   # Output: app/build/outputs/apk/debug/app-debug.apk
   ```

3. **Install langsung ke Android TV via ADB Wi-Fi**:
   ```bash
   adb connect 192.168.x.tv:5555
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

4. **Jalankan aplikasi di TV**:
   ```bash
   adb shell monkey -p com.idlix.tv.debug -c android.intent.category.LAUNCHER 1
   ```

---

##  Privasi & Keamanan

* Tidak menyimpan data pribadi atau kredensial pengguna di server manapun.
* Aplikasi ini dibuat untuk keperluan riset dan edukasi arsitektur Leanback Android TV dan pemutaran media streaming HLS.
