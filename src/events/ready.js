import { ActivityType, Events } from "discord.js";
import config from "../config/config.js";

export default {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    client.user.setPresence({
      activities: [
        {
          name: config.bot.activity,
          type: ActivityType.Watching,
        },
      ],
      status: config.bot.status,
    });

    console.log(`[READY] ${config.bot.name} online sebagai ${client.user.tag}`);
    console.log(
      `[READY] Status: ${config.bot.status} | Server terhubung: ${client.guilds.cache.size}`
    );
  },
};
