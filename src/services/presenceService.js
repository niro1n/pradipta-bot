import {
  ActivityType,
  ApplicationFlagsBitField,
  GatewayIntentBits,
} from "discord.js";
import config from "../config/config.js";

export async function hasGuildMembersIntent(token) {
  try {
    const response = await fetch("https://discord.com/api/v10/applications/@me", {
      headers: {
        Authorization: `Bot ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      if (response.status !== 401) {
        console.warn(
          `[PRESENCE WARN] Gagal memeriksa application flags Discord (status ${response.status}).`
        );
      }
      return false;
    }

    const app = await response.json();
    const flags = new ApplicationFlagsBitField(app.flags ?? 0);

    return (
      flags.has("GatewayGuildMembers") ||
      flags.has("GatewayGuildMembersLimited")
    );
  } catch (error) {
    console.warn(
      `[PRESENCE WARN] Gagal memeriksa Server Members Intent: ${error.message}`
    );
    return false;
  }
}

export async function resolveTargetGuild(client) {
  const guildId = config.discord.guildId;

  if (guildId) {
    const cached = client.guilds.cache.get(guildId);
    if (cached) return cached;

    try {
      return await client.guilds.fetch(guildId);
    } catch (error) {
      console.warn(
        `[PRESENCE WARN] Gagal mengambil guild ${guildId}: ${error.message}`
      );
      return null;
    }
  }

  return client.guilds.cache.first() ?? null;
}

export function isTargetGuild(guild) {
  if (!guild) return false;

  if (config.discord.guildId) {
    return guild.id === config.discord.guildId;
  }

  return guild.client.guilds.cache.first()?.id === guild.id;
}

export function countNonAppMembers(members) {
  return members.filter((member) => !member.user?.bot).size;
}

function setBotPresence(client, activityText) {
  client.user.setPresence({
    activities: [
      {
        name: activityText,
        type: ActivityType.Watching,
      },
    ],
    status: config.bot.status,
  });
}

export async function updateMemberPresence(client, { forceFetch = false } = {}) {
  const hasMembersIntent = client.options.intents.has(
    GatewayIntentBits.GuildMembers
  );
  const guild = await resolveTargetGuild(client);

  if (!hasMembersIntent) {
    if (forceFetch) {
      console.warn(
        '[PRESENCE WARN] Server Members Intent belum aktif di Discord Developer Portal. Akun ber-badge "APP" belum bisa difilter — menggunakan status default.'
      );
    }

    setBotPresence(client, config.bot.activity);
    return {
      mode: "fallback",
      activityText: config.bot.activity,
      humanCount: null,
      appCount: null,
      totalCount: guild?.memberCount ?? null,
    };
  }

  if (!guild) {
    console.warn(
      "[PRESENCE WARN] Target server tidak ditemukan, menggunakan status default."
    );
    setBotPresence(client, config.bot.activity);
    return {
      mode: "fallback",
      activityText: config.bot.activity,
      humanCount: null,
      appCount: null,
      totalCount: null,
    };
  }

  const members =
    forceFetch || guild.members.cache.size < guild.memberCount
      ? await guild.members.fetch()
      : guild.members.cache;

  const totalCount = members.size;
  const humanCount = countNonAppMembers(members);
  const appCount = totalCount - humanCount;
  const activityText = `${humanCount} family members`;

  setBotPresence(client, activityText);

  console.log(
    `[PRESENCE] Watching ${activityText} (Total: ${totalCount} | Non-APP: ${humanCount} | APP dilewati: ${appCount})`
  );

  return {
    mode: "memberCount",
    activityText,
    humanCount,
    appCount,
    totalCount,
  };
}
