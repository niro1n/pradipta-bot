import {
  ActivityType,
  ApplicationFlagsBitField,
  GatewayIntentBits,
} from "discord.js";
import config from "../config/config.js";

let rotationTimer = null;
let currentSlideIndex = 0;
let cachedHumanCount = null;

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

export function buildPresenceSlides(humanCount) {
  if (typeof humanCount !== "number") {
    return [
      {
<<<<<<< HEAD
        name: `🦅 ${config.bot.activity.toUpperCase()}`,
=======
        name: `🦅 ${config.bot.activity}`,
>>>>>>> 696fb6ca645a749adceaea53214dfb2e86fe787e
        type: ActivityType.Watching,
      },
    ];
  }

  return [
    {
<<<<<<< HEAD
      name: `👑 ${humanCount} FAMILY MEMBERS`,
=======
      name: `👑 ${humanCount} Family Members`,
>>>>>>> 696fb6ca645a749adceaea53214dfb2e86fe787e
      type: ActivityType.Watching,
    },
    {
      name: "🦅 PRADIPTA FAMILY",
      type: ActivityType.Watching,
    },
  ];
}

function applySlide(client, slide) {
  if (!client?.user) return;

  client.user.setPresence({
    activities: [slide],
    status: config.bot.status,
  });
}

export function stopPresenceRotation() {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}

function startPresenceRotation(client) {
  stopPresenceRotation();

  const intervalMs = config.bot.presenceIntervalMs || 15000;
  rotationTimer = setInterval(() => {
    const slides = buildPresenceSlides(cachedHumanCount);
    if (slides.length <= 1) return;

    currentSlideIndex = (currentSlideIndex + 1) % slides.length;
    applySlide(client, slides[currentSlideIndex]);
  }, intervalMs);
}

export async function updateMemberPresence(client, { forceFetch = false } = {}) {
  const hasMembersIntent = client.options.intents.has(
    GatewayIntentBits.GuildMembers
  );
  const guild = await resolveTargetGuild(client);

  if (!hasMembersIntent) {
    cachedHumanCount = null;
    stopPresenceRotation();

    if (forceFetch) {
      console.warn(
        '[PRESENCE WARN] Server Members Intent belum aktif di Discord Developer Portal. Akun ber-badge "APP" belum bisa difilter — menggunakan status default.'
      );
    }

    const fallbackSlides = buildPresenceSlides(null);
    applySlide(client, fallbackSlides[0]);

    return {
      mode: "fallback",
      activityText: fallbackSlides[0].name,
      humanCount: null,
      appCount: null,
      totalCount: guild?.memberCount ?? null,
    };
  }

  if (!guild) {
    cachedHumanCount = null;
    stopPresenceRotation();

    console.warn(
      "[PRESENCE WARN] Target server tidak ditemukan, menggunakan status default."
    );
    const fallbackSlides = buildPresenceSlides(null);
    applySlide(client, fallbackSlides[0]);

    return {
      mode: "fallback",
      activityText: fallbackSlides[0].name,
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

  cachedHumanCount = humanCount;
  currentSlideIndex = 0;

  const slides = buildPresenceSlides(humanCount);
  applySlide(client, slides[0]);
  startPresenceRotation(client);

  console.log(
    `[PRESENCE] Watching ${slides.map((s) => s.name).join(" ↔ ")} (Total: ${totalCount} | Non-APP: ${humanCount} | APP dilewati: ${appCount})`
  );

  return {
    mode: "memberCount",
    activityText: slides[0].name,
    slides: slides.map((s) => s.name),
    humanCount,
    appCount,
    totalCount,
  };
}
