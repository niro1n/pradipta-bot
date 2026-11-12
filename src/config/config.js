import "dotenv/config";

function getRequiredEnv(name) {
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
<<<<<<< HEAD
    activity: "PRADIPTA FAMILY",
=======
    activity: "Pradipta Family",
>>>>>>> 696fb6ca645a749adceaea53214dfb2e86fe787e
    presenceIntervalMs: 15000,
    timezone: "Asia/Jakarta",
  },
  discord: {
    token: getRequiredEnv("DISCORD_TOKEN"),
    clientId: process.env.CLIENT_ID?.trim() || null,
    guildId: process.env.GUILD_ID?.trim() || null,
  },
  supabase: {
    url: process.env.SUPABASE_URL?.trim() || null,
    key: process.env.SUPABASE_KEY?.trim() || null,
  },
  channels: {
    registerChannelId: process.env.REGISTER_CHANNEL_ID?.trim() || null,
    notificationChannelId: process.env.NOTIFICATION_CHANNEL_ID?.trim() || null,
    familyRoleId: process.env.FAMILY_ROLE_ID?.trim() || null,
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY?.trim() || null,
  },
};

export default config;
