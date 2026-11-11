# Pradipta Bot

Bot Discord internal keluarga Pradipta berbasis Node.js (ES Modules) dan discord.js v14.

## Struktur Project

```text
pradipta-bot/
├── src/
│   ├── commands/
│   ├── config/
│   │   └── config.js
│   ├── data/
│   ├── events/
│   │   └── ready.js
│   ├── handlers/
│   │   └── eventHandler.js
│   ├── services/
│   └── index.js
├── database/
├── .env
├── .env.example
├── .gitignore
└── package.json
```

## Menjalankan Bot

1. Salin `.env.example` menjadi `.env`, lalu isi konfigurasi yang diperlukan.
2. Jalankan mode development (watch mode):
   ```bash
   npm run dev
   ```
3. Atau jalankan mode produksi:
   ```bash
   npm start
   ```
