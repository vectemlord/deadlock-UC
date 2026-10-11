# Memperbarui hosting ke v1.2

1. Ekstrak `deadlock-v1.2-hosting.zip` ke application root Node.js yang sama dengan versi lama, mengganti file aplikasi.
2. Jalankan `npm ci --omit=dev` melalui terminal hosting atau fasilitas instalasi npm pada panel Node.js.
3. Pastikan startup file tetap `server/index.js`, lalu restart aplikasi Node.js. Restart menghapus room aktif karena state berada di memori; lakukan di luar pertandingan.
4. Buka `/api/health` pada domain game: respons harus memiliki `"ok":true` dan `"version":"1.2"`.
5. Muat ulang halaman pada semua perangkat, buat room baru, lalu bagikan link undangan dari lobby.

Server harus meneruskan WebSocket `/ws` ke proses Node yang sama. Database tidak diperlukan. Paket ini tidak mengubah pengaturan domain atau proxy hosting secara otomatis.

## Perubahan v1.2

- Pertandingan 6 menit penuh; skor 100 tidak lagi mengakhiri permainan.
- Uplink tengah: perebutan zona bersama untuk bonus throughput.
- Final Overclock: seluruh poin menjadi dua kali lipat pada menit terakhir.
- Sentinel melindungi rekan; Engineer memulihkan HP dan proses rekan.
- Rematch memakai kode room, tim, dan penonton yang sama.
- Koneksi terputus: sambung ulang otomatis, slot disimpan 45 detik; lock dilepas agar tidak menghambat pemain lain.
- Panel mobile serta kontrol penonton lebih rapi.

Link Cloudflare di `ONLINE.md` hanya link sementara dari komputer pengembang, bukan domain hosting permanen.
