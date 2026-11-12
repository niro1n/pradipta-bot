import { Events } from "discord.js";
import config from "../config/config.js";
import { updateMemberPresence } from "../services/presenceService.js";

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    await updateMemberPresence(client, { forceFetch: true });

    console.log(`[READY] ${config.bot.name} online sebagai ${client.user.tag}`);
    console.log(
      `[READY] Status: ${config.bot.status} | Server terhubung: ${client.guilds.cache.size}`
    );
  },
};
