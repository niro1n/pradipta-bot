import { Events } from "discord.js";
import config from "../config/config.js";
import { updateMemberPresence } from "../services/presenceService.js";
import { ensureRegistrationPanel } from "../services/registration.js";
import { startLiveMonitor } from "../services/notification.js";

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    await updateMemberPresence(client, { forceFetch: true });

    console.log(`[READY] ${config.bot.name} online sebagai ${client.user.tag}`);
    console.log(
      `[READY] Status: ${config.bot.status} | Server terhubung: ${client.guilds.cache.size}`
    );

    try {
      await ensureRegistrationPanel(client);
    } catch (error) {
      console.error(
        `[REGISTRATION ERROR] Gagal menyiapkan panel registrasi: ${error.message}`
      );
    }

    startLiveMonitor(client);
  },
};
