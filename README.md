# Pradipta Bot

Bot Discord internal keluarga Pradipta berbasis Node.js (ES Modules), `discord.js` v14, dan Supabase PostgreSQL, dilengkapi sistem **Live Stream Reminder** untuk YouTube dan TikTok.

## Struktur Project

```text
pradipta-bot/
├── src/
│   ├── commands/
│   ├── config/
│   │   └── config.js
│   ├── data/
│   ├── events/
│   │   ├── guildMemberAdd.js
│   │   ├── guildMemberRemove.js
│   │   ├── interactionCreate.js
│   │   └── ready.js
│   ├── handlers/
│   │   └── eventHandler.js
│   ├── services/
│   │   ├── database.js
│   │   ├── notification.js
│   │   ├── presenceService.js
│   │   ├── registration.js
│   │   ├── tiktok.js
│   │   └── youtube.js
│   ├── index.js
│   └── testDatabase.js
├── database/
│   └── schema.sql
├── .env
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Fitur Utama

1. **Panel Registrasi Permanen (`REGISTER_CHANNEL_ID`)**
   - Menggunakan satu panel Embed permanen (`STREAM NOTIFICATION REGISTRATION`) tanpa membuat duplikat ketika bot restart.
   - Terbuka bagi seluruh anggota server Discord keluarga Pradipta.
   - Mendukung pendaftaran akun **YouTube** (`@handle`, URL channel, atau Channel ID `UC...`) dan **TikTok** (`@username` atau URL profil).
   - Alur konfirmasi sebelum data disimpan ke Supabase.
2. **Manajemen Akun Anggota (`My Accounts`)**
   - Menampilkan daftar akun milik pengguna beserta status monitoring, status live, dan tanggal pendaftaran.
   - Mendukung **Edit Account** dan **Remove Account** dengan konfirmasi serta validasi kepemilikan ketat di level backend dan query database (`member_id`).
3. **Monitoring Live Stream & Notifikasi Otomatis (`NOTIFICATION_CHANNEL_ID`)**
   - **YouTube Data API v3** hemat kuota (kombinasi pengecekan kanonik `/live`, playlist `UU...` via `playlistItems.list`, dan batch `videos.list`, tanpa `search.list` yang memakan 100 unit).
   - **TikTok LIVE** melalui pembacaan metadata halaman publik dengan jeda aman per akun, tanpa meminta password/cookie maupun melanggar mekanisme proteksi.
   - Mencatat riwayat sesi live pada `live_sessions` dan mencegah duplikasi notifikasi melalui `notification_logs`.
4. **Rich Presence Dinamis**
   - Menghitung seluruh anggota keluarga non-APP (`!member.user.bot`) secara otomatis.

## Konfigurasi Environment (`.env`)

Salin `.env.example` menjadi `.env` dan sesuaikan nilainya:

```env
# Discord
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=

# Supabase
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
SUPABASE_JWKS_URL=

# Channels
REGISTER_CHANNEL_ID=1497306736158314566
NOTIFICATION_CHANNEL_ID=

# YouTube
YOUTUBE_API_KEY=
```

## Menjalankan Bot

1. Pastikan skema database telah diterapkan pada Supabase melalui `database/schema.sql`.
2. Uji koneksi database:
   ```bash
   node src/testDatabase.js
   ```
3. Validasi syntax seluruh file:
   ```bash
   npm run check
   ```
4. Jalankan bot:
   ```bash
   npm run dev
   # atau produksi:
   npm start
   ```
