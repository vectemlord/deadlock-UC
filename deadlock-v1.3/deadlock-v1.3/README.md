---
title: Deadlock Kernel Wars
emoji: ⚡
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# DEADLOCK — Kernel Wars

Game arena 3D real time **5 vs 5** untuk mempelajari deadlock lewat pertempuran, perebutan resource, koordinasi tim, dan recovery. Seluruh visual arena dibuat secara prosedural dengan Three.js; tidak membutuhkan aset berbayar atau API AI.

## Jalankan

Memerlukan Node.js 22 atau lebih baru.

```sh
npm ci
npm start
```

Buka **http://localhost:7860**. `npm install`/`npm ci` menyalin Three.js ke `public/vendor`, sehingga game tidak bergantung pada CDN JavaScript. Font Google opsional dan memiliki font fallback lokal.

- **Main sekarang**: satu pemain manusia + 9 bot, simulasi berjalan di browser; tetap dapat dimainkan saat server multiplayer terputus.
- **Multiplayer → Buat room**: bagikan kode 6 karakter. Tim dibagi otomatis, maksimum 5 manusia per tim. Host memilih apakah slot kosong diisi bot.
- Host menekan **Mulai pertempuran**. Untuk pertandingan 10 manusia, tunggu sampai kedua tim 5/5 dan nonaktifkan isi bot.
- Pemain dapat bergabung saat pertandingan berjalan, menggantikan bot pada tim yang memiliki lebih sedikit manusia.
- **Tonton Pertandingan → masukkan kode room → Tonton Saja**: maksimum 20 penonton di luar 10 slot pemain. Bisa masuk sebelum atau selama pertandingan. Penonton tidak bisa bergerak, menembak, mengambil resource, atau memulai match.
- Kamera penonton: **Seluruh Arena**, pilih operator / tombol sebelumnya-berikutnya, zoom +/−, scoreboard dan wait-for graph.
- Jika host keluar, host berpindah ke pemain berikutnya, bukan penonton. Jika semua pemain manusia keluar secara eksplisit atau masa sambung ulangnya habis, room ditutup dan penonton kembali ke menu.

### Bermain dari beberapa perangkat

Perangkat harus mengakses **server Node yang sama**. Pada Wi-Fi/LAN yang sama, buka `http://IP-KOMPUTER-SERVER:7860`, kemudian masukkan kode room. Link yang berisi `localhost` hanya berfungsi pada komputer host; buka aplikasi menggunakan IP LAN sebelum menyalin link undangan. Pastikan firewall mengizinkan port 7860. Tidak perlu mengaktifkan MySQL.

File berada di folder XAMPP, tetapi **server Node tetap diperlukan untuk multiplayer**. Apache `http://localhost/deadlock/` dapat menyajikan frontend dan mode latihan setelah dependensi terpasang; frontend akan mencoba WebSocket pada port 7860 di hostname yang sama. Jalur yang dianjurkan adalah langsung melalui server Node.

## Arena yang diperluas

Arena **84 × 56**, sekitar 2,5 kali luas versi awal (52 × 36), dengan 12 cover, jalur utara/selatan dan core lebih berjauhan. Kamera pemain mengikuti operator; minimap menampilkan seluruh wilayah. Bot mencari jalur di sekitar cover dan menyeberang pusat untuk merebut lock kedua.

## Tujuan pertandingan

Kunci **dua resource berbeda**, kembali ke core tim sendiri, dan tekan **E**. Eksekusi proses menghasilkan **20 throughput** dan melepas kedua lock. Pertandingan selalu berlangsung **6 menit penuh**, tanpa batas skor yang mengakhirinya lebih awal. Tim dengan skor tertinggi ketika waktu habis menang. Pada **60 detik terakhir (Final Overclock)**, pengiriman menjadi **40 throughput** dan bonus uplink menjadi 8. Skor sama ketika waktu habis menghasilkan seri. Eliminasi tidak memberi throughput, tetapi menghentikan proses lawan dan melepas lock-nya.

### Kerja sama tim v1.2

- **Uplink tengah** aktif mulai detik ke-35, selama 30 detik setiap siklus 75 detik. Masuk ke lingkaran untuk merebut: 6 detik solo atau 3 detik dengan minimal 2 rekan. Setelah dikuasai, tetap hadir di zona untuk mendapat +4 poin setiap 5 detik. Kedua tim hadir: capture dan poin berhenti. Proses yang menunggu lock, mati, atau terputus tidak ikut merebut. Uplink adalah bonus permainan, bukan resource lock OS kelima.
- **Sentinel** melindungi pengantar resource dan rekan yang merebut zona. **Engineer** menyembuhkan tim sekaligus memulihkan proses yang menunggu.
- **Final Overclock** menggandakan semua throughput pada menit terakhir sehingga tim tertinggal masih dapat mengejar.
- **Rematch**: setelah laporan akhir, host memilih kembali ke lobby; kode room, tim manusia, peran, dan penonton tetap. Semua skor, lock, statistik, serta timer direset. Host memulai kembali setelah semua siap. Mode latihan juga memiliki tombol main lagi.

| Kontrol | Aksi |
|---|---|
| WASD / panah | Bergerak |
| Arah mouse + klik tahan / F | Tembak |
| E | Ambil lock, request resource sibuk, atau kirim di core |
| Space | Dash, cooldown 4 detik |
| Shift | Skill kelas |
| R | Rollback: lepas semua resource dan batalkan permintaan, biaya 15 HP (tidak fatal) |
| G | Wait-for graph live |
| Tab | Scoreboard |
| H | Panduan |
| Escape | Tutup panel / menu keluar |

Ponsel: joystick kiri, tombol FIRE (bidik otomatis musuh terdekat), E, SKILL, DASH, dan ROLLBACK. Mouse belum digerakkan: tombol F juga membidik musuh terdekat. Landscape memberi ruang arena lebih luas. Proses yang kalah respawn dalam 5 detik; core sendiri memulihkan HP.

### Operator

| Kelas | HP | Skill |
|---|---:|---|
| Runner | 100 | Overdrive: bergerak lebih cepat selama 2,5 detik; cooldown 5 detik |
| Sentinel | 150 | Firewall: kebal damage selama 4 detik, rekan hidup dalam radius 9 mendapat perisai 2 detik; cooldown 12 detik |
| Engineer | 115 | Recovery pulse: rollback kooperatif rekan yang menunggu dalam radius 9 unit, heal semua rekan hidup dalam radius 9 sebesar 30 HP; cooldown 9 detik |

## Hubungan dengan materi OS

Setiap pemain adalah proses; CPU, RAM, I/O, GPU masing-masing merupakan satu resource eksklusif. Pengambilan berarti memperoleh **lock akses**, bukan memindahkan terminal fisik.

1. **Mutual exclusion:** satu resource hanya memiliki satu pemilik.
2. **Hold and wait:** pemilik tetap memegang lock saat menunggu resource kedua.
3. **No preemption:** permintaan tidak mengambil resource paksa dari pemilik. Penyelesaian proses, rollback, dan penghentian proses melepaskan resource.
4. **Circular wait:** deteksi siklus pada wait-for graph menandai proses yang deadlock. Semua proses yang menunggu berhenti bergerak/menembak; hanya yang berada dalam siklus diberi status deadlock.

Setiap panah `A → B` berarti A menunggu resource milik B. Siklus cukup untuk memastikan deadlock dalam **model single-instance ini**; tidak digeneralisasi ke resource multi-instance. Antrean berbentuk rantai tanpa siklus adalah blocking, bukan otomatis deadlock. Pemulihan oleh Engineer merupakan pembatalan proses/rollback kooperatif dengan pelepasan semua lock, bukan pencurian lock. Urutan global CPU → RAM → I/O → GPU adalah strategi pencegahan yang dapat disepakati tim; engine sengaja mengizinkan urutan lain agar pemain mengalami deadlock.

**Skenario untuk kelas:** A mengambil CPU; B mengambil RAM. A berjalan ke RAM lalu E. B berjalan ke CPU lalu E. Buka G: muncul siklus A ↔ B. A menekan R: CPU dilepas, B menerima CPU dan bisa menyelesaikan proses. Coba lagi dengan urutan resource yang konsisten untuk membandingkan hasil.

Referensi: [UIC — Operating Systems: Deadlocks](https://www.cs.uic.edu/~jbell/CourseNotes/OperatingSystems/7_Deadlocks.html).

## Arsitektur

- `shared/game.js`: aturan simulasi yang sama untuk mode latihan dan server. Deteksi siklus, AI bot, combat, collision, cooldown, score, respawn.
- `server/index.js`: HTTP dan WebSocket `/ws`, server authoritative 30 tick/s. Klien hanya mengirim input; posisi, HP, resource, dan skor dihitung server. Batas payload, laju pesan, heartbeat, pembersihan room, dan static-path allowlist.
- `src/arena.js`: arena 3D prosedural, avatar, lighting/shadow, efek tembakan, interpolasi visual.
- `src/app.js`: lobby, undangan, kontrol, HUD, graf, minimap, audio, laporan pertandingan.
- `GET /api/health`: versi server, jumlah room, pemain manusia, dan penonton yang terhubung.

State pertandingan hanya berada di memori. Restart server menghapus room. Tidak ada akun, penyimpanan progres, matchmaking lintas server, migrasi room antar instance. Gunakan **satu instance server** untuk semua peserta suatu room. Koneksi terputus melepas lock dan menghentikan input pemain; slot dan identitas ditahan 45 detik. Browser menyambung ulang otomatis memakai token privat di sessionStorage, termasuk setelah refresh. Pemain terputus tidak bisa bertempur atau merebut zona. Timer server tetap berjalan. Jika masa tenggang habis, gabung ulang memakai kode room bila room masih ada. Restart server tetap menghapus semua sesi. Belum diuji dengan 10 perangkat fisik/WAN berbeda, tetapi diuji dengan 10 klien WebSocket simultan dan 2 tab browser.

## Tes

```sh
npm test
```

Tes mencakup timer penuh walau skor melewati 100, bonus menit terakhir, capture/perebutan/penutupan uplink, skill tim, rematch, sambung ulang pemain dan penonton, penolakan token palsu, masa tenggang room, serta: kapasitas 5v5, eksklusivitas, siklus 2/3 proses, blocking tanpa siklus, rollback dan waiter, delivery, jangkauan, disconnect, batas gerak/collision, authority terhadap input palsu, skill Engineer, combat/respawn, akhir match, simulasi bot 6 menit, rute navigasi dan batas arena baru, serta integrasi server dengan 10 pemain + 20 penonton, penolakan pemain ke-11 / penonton ke-21, penolakan aksi penonton, sinkronisasi, perpindahan host, penonton masuk saat match berjalan tanpa mengganti bot, dan pembersihan room. Tes integrasi menjalankan server sementara pada port 17860.

## Hosting tetap di Singapura

Konfigurasi Docker Compose + Caddy tersedia di [`DEPLOY-SINGAPORE.md`](DEPLOY-SINGAPORE.md). Untuk 10 pemain dari Indonesia, pilih satu VPS Singapura dengan sekurangnya 2 vCPU, 2 GB RAM, dan jatah transfer yang cukup; uji ping dari perangkat pemain setelah deploy.

## Hugging Face Spaces

Dockerfile dan metadata README sudah disiapkan untuk **Docker Space**, bukan Static Space, karena multiplayer memerlukan proses server WebSocket bersama. Mengikuti [dokumentasi Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker): gunakan SDK Docker dan port 7860. GPU dan model AI tidak diperlukan.

1. Buat Space dengan SDK Docker.
2. Unggah kode sumber, `package.json`, `package-lock.json`, `Dockerfile`, dan `README.md`; abaikan `node_modules`, `artifacts`, dan folder `.git`.
3. Tunggu build. Gunakan URL aplikasi `https://NAMESPACE-SPACE.hf.space` untuk semua pemain; WebSocket otomatis memakai WSS di host yang sama.
4. Uji 2 perangkat sebelum sesi kelas. Space yang berhenti/sleep akan menghapus room aktif.

Konfigurasi siap deploy; **belum dipublikasikan atau diuji di Hugging Face**. Konektor Hugging Face pada sesi pembuatan mengembalikan `Tool hf_doc_fetch not found`, sehingga panduan resmi dibaca melalui web.

```sh
# Opsional: pengujian container lokal jika Docker sudah tersedia
 docker build -t deadlock-kernel-wars .
 docker run --rm -p 7860:7860 deadlock-kernel-wars
```

### Netcode v1.3
Lihat `CHANGELOG-v1.3.md` (perubahan, format paket, batasan) dan `EVALUATION.md` (perbandingan v1.2 vs v1.3). Jalankan `npm test` dan `npm run evaluate`; tekan **C** di game untuk sidebar perubahan.
