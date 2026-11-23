import { Events } from "discord.js";
import config from "../config/config.js";
import logger, { attachLoggerClient } from "../services/logger.js";
import { updateMemberPresence } from "../services/presenceService.js";
import { ensureRegistrationPanel } from "../services/registration.js";
import { startLiveMonitor } from "../services/notification.js";

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    attachLoggerClient(client);
    await updateMemberPresence(client, { forceFetch: true });

    logger.info(
      "READY",
      `${config.bot.name} online sebagai ${client.user.tag} (Status: ${config.bot.status} | Server: ${client.guilds.cache.size})`,
      {
        botUser: client.user.tag,
        guilds: client.guilds.cache.size,
      },
      { persistDb: true }
    );

    try {
      await ensureRegistrationPanel(client);
    } catch (error) {
      logger.error(
        "REGISTRATION",
        `Gagal menyiapkan panel registrasi: ${error.message}`,
        { error }
      );
    }

    startLiveMonitor(client);
  },
};
