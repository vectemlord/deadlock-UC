# Link online sementara

Diperiksa kembali 6 Oktober 2026 melalui Cloudflare Quick Tunnel:

https://hanging-radio-copyrights-gnu.trycloudflare.com

Link meneruskan HTTPS dan WebSocket ke server game pada port 7860 komputer ini. Semua pemain membuka alamat di atas, satu pemain membuat room, lalu pemain lain memasukkan kode room yang sama.

Link ini bukan hosting permanen. Komputer harus tetap menyala, terhubung internet, dan tidak sleep; server Node serta proses cloudflared harus tetap berjalan. Restart tunnel menghasilkan alamat baru.

Proses server: `npm start` dari folder proyek.

Perintah tunnel untuk membuat link baru jika diperlukan:

```sh
/private/tmp/deadlock-cloudflared/cloudflared tunnel --url http://127.0.0.1:7860 --no-autoupdate --protocol http2
```

Binary sementara di `/private/tmp` berasal dari rilis resmi https://github.com/cloudflare/cloudflared dan dapat dibersihkan oleh sistem. Jika binary tidak tersedia, instal cloudflared resmi terlebih dahulu.

Referensi: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/

Pembaruan v1.1: arena 84 × 56 (12 cover), kamera mengikuti pemain, dan maksimal 20 penonton terpisah dari 10 pemain. Untuk menonton: Tonton Pertandingan → kode room → Tonton Saja. Pilih seluruh arena atau ikuti operator, atur zoom, dan buka graf atau skor.

Pembaruan v1.2: pertandingan 6 menit penuh tanpa batas skor 100, uplink tengah, bonus poin dua kali lipat pada menit terakhir, skill pelindung/heal untuk rekan, rematch di room yang sama, dan reconnect otomatis dengan masa tenggang 45 detik. Endpoint `/api/health` menampilkan versi `1.3`.

Pembaruan v1.3 (netcode): paket status biner (~95% lebih kecil), interpolasi, prediksi sisi klien, backpressure, dan endpoint `/api/metrics`. Tekan **C** di dalam game untuk membuka sidebar perubahan kode dan angka jaringan langsung. Detail: `CHANGELOG-v1.3.md`, hasil uji: `EVALUATION.md`.
