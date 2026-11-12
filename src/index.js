import { Client, Events, GatewayIntentBits } from "discord.js";
import config from "./config/config.js";
import { loadEvents } from "./handlers/eventHandler.js";
import { hasGuildMembersIntent } from "./services/presenceService.js";

let client = null;

process.on("unhandledRejection", (error) => {
  console.error("[UNHANDLED REJECTION]", error);
});

const shutdown = (signal) => {
  console.log(`\n[BOT] Menerima ${signal}, menutup koneksi bot...`);
  if (client) {
    client.destroy();
  }
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function start() {
  console.log(`[BOT] Memulai ${config.bot.name}...`);

  const guildMembersEnabled = await hasGuildMembersIntent(config.discord.token);
  const intents = [GatewayIntentBits.Guilds];

  if (guildMembersEnabled) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  client = new Client({ intents });

  client.on(Events.Error, (error) => {
    console.error("[DISCORD ERROR]", error);
  });

  await loadEvents(client);

  console.log("[BOT] Menghubungkan ke Discord...");
  await client.login(config.discord.token);
}

start().catch((error) => {
  console.error("[BOT ERROR] Gagal menjalankan bot:", error);
  if (client) {
    client.destroy();
  }
  process.exitCode = 1;
});
