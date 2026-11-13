import "dotenv/config";

export function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${name} wajib diisi.`);
  }
  return value;
}

export const config = {
  bot: {
    name: "Pradipta Bot",
    status: "online",
    activity: "PRADIPTA FAMILY",
    presenceIntervalMs: 15000,
    monitorIntervalMs: 120000,
    timezone: "Asia/Jakarta",
  },
  discord: {
    token: getRequiredEnv("DISCORD_TOKEN"),
    clientId: process.env.CLIENT_ID?.trim() || null,
    guildId: process.env.GUILD_ID?.trim() || null,
  },
  supabase: {
    url: process.env.SUPABASE_URL?.trim() || null,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || null,
    secretKey: process.env.SUPABASE_SECRET_KEY?.trim() || null,
    jwksUrl: process.env.SUPABASE_JWKS_URL?.trim() || null,
  },
  channels: {
    registerChannelId: process.env.REGISTER_CHANNEL_ID?.trim() || null,
    notificationChannelId: process.env.NOTIFICATION_CHANNEL_ID?.trim() || null,
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY?.trim() || null,
  },
};

export function validateSupabaseConfig() {
  const missing = [];
  if (!config.supabase.url) missing.push("SUPABASE_URL");
  if (!config.supabase.secretKey) missing.push("SUPABASE_SECRET_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Konfigurasi Supabase belum lengkap. Environment variable wajib diisi: ${missing.join(", ")}`
    );
  }

  return config.supabase;
}

export default config;
