import { Events } from "discord.js";
import {
  isTargetGuild,
  updateMemberPresence,
} from "../services/presenceService.js";

export default {
  name: Events.GuildMemberRemove,
  once: false,
  async execute(member) {
    if (!isTargetGuild(member.guild) || member.user?.bot) {
      return;
    }

    await updateMemberPresence(member.client);
  },
};
