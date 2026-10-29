require('./src/app').start().catch((error) => {
  console.error('[startup] Gagal menjalankan bot:', error);
  process.exitCode = 1;
});