import {
  ActivityType,
  ApplicationFlagsBitField,
  GatewayIntentBits,
} from "discord.js";
import config from "../config/config.js";
import supabase from "./database.js";

let rotationTimer = null;
let currentSlideIndex = 0;
let cachedHumanCount = null;
let cachedStreamerStats = {
  totalStreamers: 0,
  youtubeStreamers: 0,
  tiktokStreamers: 0,
};

export async function fetchStreamerStats() {
  try {
    const { data: accounts, error } = await supabase
      .from("stream_accounts")
      .select("member_id, platform")
      .eq("is_active", true);

    if (error || !accounts) {
      return cachedStreamerStats;
    }

    const totalSet = new Set();
    const youtubeSet = new Set();
    const tiktokSet = new Set();

    for (const acc of accounts) {
      if (!acc.member_id) continue;
      totalSet.add(acc.member_id);
      if (acc.platform === "youtube") {
        youtubeSet.add(acc.member_id);
      } else if (acc.platform === "tiktok") {
        tiktokSet.add(acc.member_id);
      }
    }

    cachedStreamerStats = {
      totalStreamers: totalSet.size,
      youtubeStreamers: youtubeSet.size,
      tiktokStreamers: tiktokSet.size,
    };
  } catch {}

  return cachedStreamerStats;
}

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

export function buildPresenceSlides(humanCount, streamerStats = cachedStreamerStats) {
  const slides = [];

  if (typeof humanCount === "number") {
    slides.push({
      name: `👑 ${humanCount} FAMILY MEMBERS`,
      type: ActivityType.Watching,
    });
  }

  if (streamerStats && typeof streamerStats.totalStreamers === "number") {
    slides.push(
      {
        name: `🎥 ${streamerStats.totalStreamers} TOTAL STREAMERS`,
        type: ActivityType.Watching,
      },
      {
        name: `📺 ${streamerStats.youtubeStreamers} YOUTUBE STREAMERS`,
        type: ActivityType.Watching,
      },
      {
        name: `🎵 ${streamerStats.tiktokStreamers} TIKTOK STREAMERS`,
        type: ActivityType.Watching,
      }
    );
  }

  slides.push({
    name: `🦅 ${config.bot.activity.toUpperCase()}`,
    type: ActivityType.Watching,
  });

  return slides;
}

function applySlide(client, slide) {
  if (!client?.user || !slide) return;

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
  rotationTimer = setInterval(async () => {
    const slides = buildPresenceSlides(cachedHumanCount, cachedStreamerStats);
    if (slides.length <= 1) return;

    currentSlideIndex = (currentSlideIndex + 1) % slides.length;
    applySlide(client, slides[currentSlideIndex]);

    if (currentSlideIndex === 0) {
      await fetchStreamerStats();
    }
  }, intervalMs);
  rotationTimer.unref?.();
}

export async function updateMemberPresence(client, { forceFetch = false } = {}) {
  if (forceFetch || cachedStreamerStats.totalStreamers === 0) {
    await fetchStreamerStats();
  }

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

    const fallbackSlides = buildPresenceSlides(null, cachedStreamerStats);
    applySlide(client, fallbackSlides[0]);
    startPresenceRotation(client);

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
    const fallbackSlides = buildPresenceSlides(null, cachedStreamerStats);
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

  const slides = buildPresenceSlides(humanCount, cachedStreamerStats);
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
