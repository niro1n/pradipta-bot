import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from "discord.js";
import config from "../config/config.js";
import supabase from "./database.js";
import { checkYouTubeAccountsLive } from "./youtube.js";
import { checkTikTokAccountsLive } from "./tiktok.js";

let monitorTimer = null;
let isRunningCycle = false;

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

  // Duplicate guard via notification_logs
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

  const embed = new EmbedBuilder()
    .setColor(getPlatformColor(account.platform))
    .setTitle(liveInfo.title || `${account.username} sedang LIVE!`)
    .setURL(liveInfo.streamUrl)
    .setDescription(
      `🔴 **${streamerMention}** sedang melakukan live streaming di **${platformLabel}**! Yuk ramaikan sekarang.`
    )
    .addFields(
      {
        name: "👤 Streamer",
        value: `${streamerMention} (\`${account.username}\`)`,
        inline: true,
      },
      {
        name: "📡 Platform",
        value: platformLabel,
        inline: true,
      },
      {
        name: "🔗 Link Live",
        value: `[Tonton Live](${liveInfo.streamUrl})`,
        inline: true,
      }
    )
    .setFooter({ text: "Pradipta Family • Live Stream Notification" })
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
      .setEmoji("🔴")
  );

  await channel.send({
    content: `🔴 **LIVE ALERT!** ${streamerMention} sedang live di **${platformLabel}**!`,
    embeds: [embed],
    components: [row],
    allowedMentions: {
      users: discordUserId ? [discordUserId] : [],
    },
  });

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

async function handleAccountStatusTransition(client, account, liveResult) {
  const nowIso = new Date().toISOString();

  if (liveResult.isLive && liveResult.streamId) {
    await supabase
      .from("stream_accounts")
      .update({
        is_live: true,
        last_checked_at: nowIso,
      })
      .eq("id", account.id);

    // Record or keep active live_sessions row
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
    return;
  }

  // Only mark offline when data source responded authoritatively
  if (liveResult.available !== false) {
    if (account.is_live) {
      await supabase
        .from("stream_accounts")
        .update({
          is_live: false,
          last_checked_at: nowIso,
        })
        .eq("id", account.id);

      await supabase
        .from("live_sessions")
        .update({ ended_at: nowIso })
        .eq("account_id", account.id)
        .is("ended_at", null);

      console.log(
        `[MONITOR] ${account.platform.toUpperCase()} ${account.username} kini OFFLINE.`
      );
    } else {
      await supabase
        .from("stream_accounts")
        .update({ last_checked_at: nowIso })
        .eq("id", account.id);
    }
  }
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

    const [ytResults, ttResults] = await Promise.all([
      checkYouTubeAccountsLive(youtubeAccounts, { force }),
      checkTikTokAccountsLive(tiktokAccounts, { force }),
    ]);

    for (const account of accounts) {
      const liveResult =
        account.platform === "youtube"
          ? ytResults.get(account.id)
          : ttResults.get(account.id);

      if (!liveResult) continue;

      try {
        await handleAccountStatusTransition(client, account, liveResult);
      } catch (err) {
        console.error(
          `[MONITOR] Error saat memproses status ${account.username}: ${err.message}`
        );
      }
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

  const intervalMs = config.bot.monitorIntervalMs || 120000;
  console.log(
    `[MONITOR] Live stream monitor aktif (interval: ${Math.round(intervalMs / 1000)}s)`
  );

  // Run initial check after 10 seconds so startup completes cleanly
  setTimeout(() => {
    runLiveMonitorCycle(client).catch((err) =>
      console.error("[MONITOR] Initial cycle error:", err.message)
    );
  }, 10000).unref();

  monitorTimer = setInterval(() => {
    runLiveMonitorCycle(client).catch((err) =>
      console.error("[MONITOR] Cycle error:", err.message)
    );
  }, intervalMs);
}
