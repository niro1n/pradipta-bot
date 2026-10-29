# Pradipta Bot

Bot Discord sederhana.

## Struktur project

```text
.
├── index.js                    # Entry point
├── src/
│   ├── app.js                  # Bootstrap aplikasi
│   ├── config/
│   │   └── index.js            # Validasi environment variable
│   ├── commands/               # Registry, definisi, dan handler slash command
│   │   ├── ping.js
│   │   └── registry.js
│   ├── discord/                # Client dan fitur Discord
│   │   ├── client.js
│   │   └── command-registration.js
├── .env.example
└── package.json
```

## Menjalankan

1. Salin `.env.example` menjadi `.env`, lalu isi kredensial Discord.
2. Install dependency dengan `npm install`.
3. Jalankan bot dengan `npm start`.

Command yang tersedia:

- `/ping` — menampilkan latensi bot.
