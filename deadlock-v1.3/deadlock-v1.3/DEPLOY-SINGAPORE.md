# Server tetap untuk 10 pemain

Pilihan awal: DigitalOcean Droplet **Basic, 2 vCPU, 2 GB RAM, 60 GB SSD, 3 TB transfer, region SGP1 Singapore**. Per 6 Oktober 2026, harga resmi paket ini **US$18/bulan** sebelum pajak dan biaya tambahan. Pilih **Ubuntu 24.04 LTS**, IPv4 publik, dan akses SSH key. Tidak perlu GPU atau database. Satu instance menjalankan semua room agar state WebSocket tetap bersama.

Game memproses simulasi 30 tick/detik dan mengirim satu snapshot JSON sekitar 3,9 KB ke tiap klien per tick. Sepuluh pemain penuh berarti sekitar **9,4 Mbps trafik keluar** atau **421 MB per match 6 menit** sebelum overhead. Penonton memakai trafik tambahan dengan rasio yang sama. Angka ini berasal dari ukuran snapshot kode lokal, bukan jaminan latency internet. Jika pemain sangat sering menonton atau banyak room berjalan bersamaan, pantau kuota transfer dan CPU.

1. Buat Droplet di `sgp1`. Buka TCP 80/443 dan UDP 443 pada firewall. Port 7860 cukup berada dalam jaringan Docker; tidak perlu dibuka publik.
2. Ubah DNS `A` untuk `deadlock.vibecheck.id` ke IPv4 Droplet. Tunggu hingga DNS menunjuk IP baru.
3. Instal Docker Engine beserta plugin Compose menurut panduan resmi: <https://docs.docker.com/engine/install/ubuntu/>. Jalankan daemon Docker.
4. Unggah isi paket `deadlock-v1.2-hosting.zip` ke direktori aplikasi di Droplet, lalu ekstrak. Contoh dari komputer lokal:

   ```sh
   scp artifacts/deadlock-v1.2-hosting.zip ubuntu@IP_SERVER:~/
   ssh ubuntu@IP_SERVER
   mkdir -p ~/deadlock && cd ~/deadlock
   unzip -o ../deadlock-v1.2-hosting.zip
   cp .env.example .env
   docker compose up -d --build
   ```

5. Uji `https://deadlock.vibecheck.id/api/health`: respons harus `"ok":true` dan `"version":"1.2"`. Lalu uji dua browser berbeda melalui `https://deadlock.vibecheck.id/`, buat room, join dengan kode, dan coba mode penonton. Caddy otomatis menangani HTTPS dan WebSocket `/ws` lewat reverse proxy.

Untuk memperbarui game, unggah paket baru dan jalankan `docker compose up -d --build`. Karena room disimpan di memori Node, lakukan restart ketika pertandingan selesai. Monitor dengan `docker compose logs -f --tail=100` dan metrik CPU/transfer di panel Droplet.

## Batas penting

Spesifikasi di atas adalah titik awal yang layak untuk **satu room 10 pemain**. Tidak ada penyedia yang bisa menjamin tanpa lag sebelum diuji dari koneksi dan perangkat kesepuluh pemain. Target praktis: ping <100 ms stabil, tidak ada packet loss yang berarti, CPU server tetap di bawah sekitar 70%, dan frame rate browser cukup lancar. Jika 20 penonton aktif, trafik tiga kali lebih besar daripada hanya 10 pemain.
