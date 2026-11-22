import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import config from "../config/config.js";
import supabase from "./database.js";
import {
  checkYouTubeAccountsContent,
  checkYouTubeAccountsLive,
} from "./youtube.js";
import {
  checkTikTokAccountsContent,
  checkTikTokAccountsLive,
} from "./tiktok.js";
import { ensureRegistrationPanel } from "./registration.js";

let monitorTimer = null;
let isRunningCycle = false;
const notifiedStreamsCache = new Set();
const contentMonitorBootMs = Date.now() - 5 * 60 * 1000;

function formatPlatformLabel(platform) {
  return platform === "youtube" ? "YouTube" : "TikTok";
}

function getPlatformColor(platform) {
  return platform === "youtube" ? 0xff0000 : 0x00f2fe;
}

export async function sendLiveNotification(client, { account, member, liveInfo }) {
  const channelId = config.channels.notificationChannelId;
  if (!channelId) {
    console.warn(
      "[NOTIFICATION] NOTIFICATION_CHANNEL_ID belum dikonfigurasi, melewati pengiriman notifikasi."
    );
    return { sent: false, reason: "missing_channel_id" };
  }

  const cacheKey = `${account.id}:${liveInfo.streamId}:${channelId}`;
  if (notifiedStreamsCache.has(cacheKey)) {
    return { sent: false, duplicate: true };
  }

  const { data: existingLog, error: checkError } = await supabase
    .from("notification_logs")
    .select("id")
    .eq("account_id", account.id)
    .eq("stream_id", liveInfo.streamId)
    .eq("channel_id", channelId)
    .maybeSingle();

  if (checkError) {
    console.error(
      `[NOTIFICATION] Gagal memeriksa notification_logs: ${checkError.message}`
    );
  }

  if (existingLog?.id) {
    notifiedStreamsCache.add(cacheKey);
    return { sent: false, duplicate: true };
  }

  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    console.error(
      `[NOTIFICATION] Channel notifikasi (${channelId}) tidak ditemukan atau bukan text channel.`
    );
    return { sent: false, reason: "invalid_channel" };
  }

  const platformLabel = formatPlatformLabel(account.platform);
  const discordUserId = member?.discord_user_id || null;
  const streamerMention = discordUserId
    ? `<@${discordUserId}>`
    : member?.discord_username || account.username;

  const embedTitle = String(
    liveInfo.title || `${account.username} LAGI LIVE!`
  )
    .slice(0, 250)
    .toUpperCase();

  const embed = new EmbedBuilder()
    .setColor(getPlatformColor(account.platform))
    .setTitle(embedTitle)
    .setURL(liveInfo.streamUrl)
    .setDescription(
      `${streamerMention} (\`${account.username}\`) • **${platformLabel} Live**`
    )
    .setTimestamp(liveInfo.startedAt ? new Date(liveInfo.startedAt) : new Date());

  if (
    typeof liveInfo.thumbnailUrl === "string" &&
    liveInfo.thumbnailUrl.startsWith("http")
  ) {
    embed.setImage(liveInfo.thumbnailUrl);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(`Tonton di ${platformLabel}`)
      .setStyle(ButtonStyle.Link)
      .setURL(liveInfo.streamUrl)
  );

  await channel.send({
    content: `@everyone @here ${streamerMention} lagi live di **${platformLabel}**.`,
    embeds: [embed],
    components: [row],
    allowedMentions: {
      parse: ["everyone"],
      users: discordUserId ? [discordUserId] : [],
    },
  });

  if (notifiedStreamsCache.size > 500) {
    notifiedStreamsCache.clear();
  }
  notifiedStreamsCache.add(cacheKey);

  const { error: logError } = await supabase.from("notification_logs").insert({
    account_id: account.id,
    stream_id: liveInfo.streamId,
    channel_id: channelId,
    sent_at: new Date().toISOString(),
  });

  if (logError && !logError.message.includes("duplicate")) {
    console.error(
      `[NOTIFICATION] Gagal mencatat notification_logs: ${logError.message}`
    );
  }

  console.log(
    `[NOTIFICATION] Notifikasi LIVE terkirim untuk ${account.platform}:${account.username} (streamId: ${liveInfo.streamId})`
  );

  return { sent: true, streamId: liveInfo.streamId };
}

export async function sendContentNotification(
  client,
  { account, member, contentInfo }
) {
  const channelId = config.channels.contentChannelId;
  if (!channelId) {
    return { sent: false, reason: "missing_content_channel_id" };
  }

  const logStreamId = `content:${contentInfo.contentId}`;
  const cacheKey = `${account.id}:${logStreamId}:${channelId}`;
  if (notifiedStreamsCache.has(cacheKey)) {
    return { sent: false, duplicate: true };
  }

  const { data: existingLog, error: checkError } = await supabase
    .from("notification_logs")
    .select("id")
    .eq("account_id", account.id)
    .eq("stream_id", logStreamId)
    .eq("channel_id", channelId)
    .maybeSingle();

  if (checkError) {
    console.error(
      `[CONTENT] Gagal memeriksa notification_logs: ${checkError.message}`
    );
  }

  if (existingLog?.id) {
    notifiedStreamsCache.add(cacheKey);
    return { sent: false, duplicate: true };
  }

  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    console.error(
      `[CONTENT] Channel konten (${channelId}) tidak ditemukan atau bukan text channel.`
    );
    return { sent: false, reason: "invalid_channel" };
  }

  const platformLabel = formatPlatformLabel(account.platform);
  const discordUserId = member?.discord_user_id || null;
  const streamerMention = discordUserId
    ? `<@${discordUserId}>`
    : member?.discord_username || account.username;

  const embedTitle = String(
    contentInfo.title || `${account.username} UPLOAD KONTEN BARU!`
  )
    .slice(0, 250)
    .toUpperCase();

  const embed = new EmbedBuilder()
    .setColor(getPlatformColor(account.platform))
    .setTitle(embedTitle)
    .setURL(contentInfo.contentUrl)
    .setDescription(
      `${streamerMention} (\`${account.username}\`) • **${platformLabel}**`
    )
    .setTimestamp(
      contentInfo.publishedAt ? new Date(contentInfo.publishedAt) : new Date()
    );

  if (
    typeof contentInfo.thumbnailUrl === "string" &&
    contentInfo.thumbnailUrl.startsWith("http")
  ) {
    embed.setImage(contentInfo.thumbnailUrl);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(`Tonton di ${platformLabel}`)
      .setStyle(ButtonStyle.Link)
      .setURL(contentInfo.contentUrl)
  );

  await channel.send({
    content: `@everyone @here ${streamerMention} baru upload konten di **${platformLabel}**.`,
    embeds: [embed],
    components: [row],
    allowedMentions: {
      parse: ["everyone"],
      users: discordUserId ? [discordUserId] : [],
    },
  });

  if (notifiedStreamsCache.size > 500) {
    notifiedStreamsCache.clear();
  }
  notifiedStreamsCache.add(cacheKey);

  const { error: logError } = await supabase.from("notification_logs").insert({
    account_id: account.id,
    stream_id: logStreamId,
    channel_id: channelId,
    sent_at: new Date().toISOString(),
  });

  if (logError && !logError.message.includes("duplicate")) {
    console.error(
      `[CONTENT] Gagal mencatat notification_logs: ${logError.message}`
    );
  }

  console.log(
    `[CONTENT] Notifikasi KONTEN terkirim untuk ${account.platform}:${account.username} (contentId: ${contentInfo.contentId})`
  );

  return { sent: true, contentId: contentInfo.contentId };
}

async function handleAccountLiveState(client, account, liveResult, nowIso) {
  await supabase
    .from("stream_accounts")
    .update({
      is_live: true,
      last_checked_at: nowIso,
    })
    .eq("id", account.id);

  const { data: existingSession } = await supabase
    .from("live_sessions")
    .select("id, ended_at")
    .eq("account_id", account.id)
    .eq("stream_id", liveResult.streamId)
    .maybeSingle();

  if (!existingSession) {
    await supabase.from("live_sessions").insert({
      account_id: account.id,
      stream_id: liveResult.streamId,
      title: liveResult.title || null,
      started_at: liveResult.startedAt || nowIso,
    });
  } else if (existingSession.ended_at) {
    await supabase
      .from("live_sessions")
      .update({ ended_at: null })
      .eq("id", existingSession.id);
  }

  await sendLiveNotification(client, {
    account,
    member: account.family_members,
    liveInfo: liveResult,
  });

  return !account.is_live;
}

async function handleAccountOfflineTransition(account, nowIso) {
  await Promise.all([
    supabase
      .from("stream_accounts")
      .update({
        is_live: false,
        last_checked_at: nowIso,
      })
      .eq("id", account.id),
    supabase
      .from("live_sessions")
      .update({ ended_at: nowIso })
      .eq("account_id", account.id)
      .is("ended_at", null),
  ]);

  console.log(
    `[MONITOR] ${account.platform.toUpperCase()} ${account.username} kini OFFLINE.`
  );

  return true;
}

export async function runLiveMonitorCycle(client, { force = false } = {}) {
  if (isRunningCycle) {
    return;
  }

  isRunningCycle = true;
  try {
    const { data: accounts, error } = await supabase
      .from("stream_accounts")
      .select("*, family_members(id, discord_user_id, discord_username)")
      .eq("is_active", true);

    if (error) {
      console.error(`[MONITOR] Gagal mengambil daftar akun: ${error.message}`);
      return;
    }

    if (!accounts || accounts.length === 0) {
      return;
    }

    const youtubeAccounts = accounts.filter((a) => a.platform === "youtube");
    const tiktokAccounts = accounts.filter((a) => a.platform === "tiktok");

    const [ytResults, ttResults, ytContentResults, ttContentResults] =
      await Promise.all([
        checkYouTubeAccountsLive(youtubeAccounts, { force }),
        checkTikTokAccountsLive(tiktokAccounts, { force }),
        checkYouTubeAccountsContent(youtubeAccounts, {
          sinceTimestampMs: contentMonitorBootMs,
          force,
        }),
        checkTikTokAccountsContent(tiktokAccounts, {
          sinceTimestampMs: contentMonitorBootMs,
          force,
        }),
      ]);

    const nowIso = new Date().toISOString();
    const unchangedOfflineIds = [];
    let panelNeedsRefresh = false;

    for (const account of accounts) {
      const contentList =
        account.platform === "youtube"
          ? ytContentResults.get(account.id)
          : ttContentResults.get(account.id);

      if (Array.isArray(contentList) && contentList.length > 0) {
        for (const contentInfo of contentList) {
          try {
            await sendContentNotification(client, {
              account,
              member: account.family_members,
              contentInfo,
            });
          } catch (contentErr) {
            console.error(
              `[CONTENT] Error saat mengirim notif konten ${account.username}: ${contentErr.message}`
            );
          }
        }
      }

      const liveResult =
        account.platform === "youtube"
          ? ytResults.get(account.id)
          : ttResults.get(account.id);

      if (!liveResult) continue;

      try {
        if (liveResult.isLive && liveResult.streamId) {
          const transitioned = await handleAccountLiveState(
            client,
            account,
            liveResult,
            nowIso
          );
          if (transitioned) panelNeedsRefresh = true;
        } else if (liveResult.available !== false) {
          if (account.is_live) {
            await handleAccountOfflineTransition(account, nowIso);
            panelNeedsRefresh = true;
          } else {
            unchangedOfflineIds.push(account.id);
          }
        }
      } catch (err) {
        console.error(
          `[MONITOR] Error saat memproses status ${account.username}: ${err.message}`
        );
      }
    }

    if (unchangedOfflineIds.length > 0) {
      await supabase
        .from("stream_accounts")
        .update({ last_checked_at: nowIso })
        .in("id", unchangedOfflineIds);
    }

    if (panelNeedsRefresh) {
      ensureRegistrationPanel(client).catch(() => {});
    }
  } catch (error) {
    console.error(`[MONITOR] Kesalahan pada siklus monitoring: ${error.message}`);
  } finally {
    isRunningCycle = false;
  }
}

export function stopLiveMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

export function startLiveMonitor(client) {
  stopLiveMonitor();

  const intervalMs = config.bot.monitorIntervalMs || 15000;
  console.log(
    `[MONITOR] Live stream monitor aktif (interval: ${Math.round(intervalMs / 1000)}s)`
  );

  setTimeout(() => {
    runLiveMonitorCycle(client).catch((err) =>
      console.error("[MONITOR] Initial cycle error:", err.message)
    );
  }, 3000).unref();

  monitorTimer = setInterval(() => {
    runLiveMonitorCycle(client).catch((err) =>
      console.error("[MONITOR] Cycle error:", err.message)
    );
  }, intervalMs);
  monitorTimer.unref?.();
}
