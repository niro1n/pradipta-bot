import { Client, Events, GatewayIntentBits } from "discord.js";
import config from "./config/config.js";
import { loadEvents } from "./handlers/eventHandler.js";
import logger from "./services/logger.js";
import {
  hasGuildMembersIntent,
  stopPresenceRotation,
} from "./services/presenceService.js";
import { stopLiveMonitor } from "./services/notification.js";

let client = null;

process.on("unhandledRejection", (error) => {
  logger.error("UNHANDLED_REJECTION", error?.message || String(error), {
    error,
  });
});

process.on("uncaughtException", (error) => {
  logger.error("UNCAUGHT_EXCEPTION", error?.message || String(error), {
    error,
  });
});

const shutdown = (signal) => {
  logger.info(
    "BOT",
    `Menerima ${signal}, menutup koneksi bot...`,
    { signal },
    { persistDb: true }
  );
  stopPresenceRotation();
  stopLiveMonitor();
  if (client) {
    client.destroy();
  }
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function start() {
  logger.info("BOT", `Memulai ${config.bot.name}...`);

  const guildMembersEnabled = await hasGuildMembersIntent(config.discord.token);
  const intents = [GatewayIntentBits.Guilds];

  if (guildMembersEnabled) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  client = new Client({ intents });

  client.on(Events.Error, (error) => {
    logger.error("DISCORD", error?.message || String(error), { error });
  });

  await loadEvents(client);

  logger.info("BOT", "Menghubungkan ke Discord...");
  await client.login(config.discord.token);
}

start().catch((error) => {
  logger.error("BOT", `Gagal menjalankan bot: ${error?.message || error}`, {
    error,
  });
  stopPresenceRotation();
  stopLiveMonitor();
  if (client) {
    client.destroy();
  }
  process.exitCode = 1;
});
