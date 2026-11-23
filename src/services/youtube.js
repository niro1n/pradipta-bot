import config from "../config/config.js";
import logger from "./logger.js";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 8000;
const MIN_CHECK_INTERVAL_MS = 12 * 1000;
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

let quotaCooldownUntil = 0;
let totalQuotaUnitsUsed = 0;
let totalApiRequests = 0;
const lastCheckedMap = new Map();
const lastContentCheckedMap = new Map();
const finishedVideoIds = new Set();
const seenContentVideoIds = new Set();
const baselinedYouTubeAccounts = new Set();
const CONTENT_CHECK_INTERVAL_MS = 45 * 1000;
const MAX_POST_AGE_AFTER_BASELINE_MS = 24 * 60 * 60 * 1000;
const INITIAL_BASELINE_RECENT_WINDOW_MS = 15 * 60 * 1000;

function sanitizeErrorMessage(message) {
  const apiKey = config.youtube.apiKey;
  if (apiKey && typeof message === "string") {
    return message.replaceAll(apiKey, "[REDACTED_API_KEY]");
  }
  return message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getYouTubeApiStats() {
  return {
    totalApiRequests,
    totalQuotaUnitsUsed,
    quotaCooldownActive: Date.now() < quotaCooldownUntil,
    quotaCooldownUntil: quotaCooldownUntil > Date.now() ? new Date(quotaCooldownUntil).toISOString() : null,
  };
}

export function parseYouTubeInput(rawInput) {
  const input = typeof rawInput === "string" ? rawInput.trim() : "";

  if (!input) {
    throw new Error("Input akun YouTube tidak boleh kosong.");
  }

  if (/tiktok\.com/i.test(input)) {
    throw new Error("URL yang dimasukkan adalah URL TikTok, bukan YouTube.");
  }

  if (/^UC[\w-]{22}$/.test(input)) {
    return { type: "channelId", value: input };
  }

  if (/^@[a-zA-Z0-9._-]{3,30}$/.test(input)) {
    return { type: "handle", value: input };
  }

  if (/^https?:\/\//i.test(input) || /^(www\.|m\.)?youtube\.com\//i.test(input)) {
    const normalizedUrl = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    let parsedUrl;

    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw new Error("Format URL YouTube tidak valid.");
    }

    const host = parsedUrl.hostname.toLowerCase();
    if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      throw new Error("Domain URL harus berasal dari youtube.com.");
    }

    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    if (segments.length === 0) {
      throw new Error("URL YouTube tidak mengandung nama channel atau ID.");
    }

    const first = decodeURIComponent(segments[0]);
    const second = segments[1] ? decodeURIComponent(segments[1]) : null;

    if (first === "channel" && second && /^UC[\w-]{22}$/.test(second)) {
      return { type: "channelId", value: second };
    }

    if (first.startsWith("@") && /^@[a-zA-Z0-9._-]{3,30}$/.test(first)) {
      return { type: "handle", value: first };
    }

    if ((first === "c" || first === "user") && second) {
      return {
        type: "handle",
        value: second.startsWith("@") ? second : `@${second}`,
        fallbackUsername: second.replace(/^@/, ""),
      };
    }

    if (/^[a-zA-Z0-9._-]{3,30}$/.test(first) && !["watch", "shorts", "live", "playlist", "feed", "results"].includes(first.toLowerCase())) {
      return {
        type: "handle",
        value: `@${first}`,
        fallbackUsername: first,
      };
    }

    throw new Error(
      "Format URL YouTube tidak dikenali. Gunakan URL seperti https://www.youtube.com/@username atau https://www.youtube.com/channel/UC..."
    );
  }

  if (/^[a-zA-Z0-9._-]{3,30}$/.test(input)) {
    return {
      type: "handle",
      value: `@${input}`,
      fallbackUsername: input,
    };
  }

  throw new Error(
    "Format input YouTube tidak valid. Masukkan @handle, Channel ID (UC...), atau URL channel YouTube."
  );
}

async function callYouTubeApi(endpoint, params, quotaCost = 1, maxRetries = 2) {
  const apiKey = config.youtube.apiKey;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY belum dikonfigurasi di environment.");
  }

  if (Date.now() < quotaCooldownUntil) {
    const remainingMin = Math.ceil((quotaCooldownUntil - Date.now()) / 60000);
    throw new Error(`Kuota YouTube API sedang dalam masa jeda (${remainingMin} menit tersisa).`);
  }

  const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  }
  url.searchParams.set("key", apiKey);

  let attempt = 0;
  while (true) {
    attempt += 1;
    totalApiRequests += 1;
    totalQuotaUnitsUsed += quotaCost;

    try {
      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = await response.json();
        logger.info(
          "YOUTUBE",
          `${endpoint} | cost=${quotaCost} | totalUnits=${totalQuotaUnitsUsed}`
        );
        return data;
      }

      const errorText = await response.text();
      let errorJson = null;
      try {
        errorJson = JSON.parse(errorText);
      } catch {}

      const reason = errorJson?.error?.errors?.[0]?.reason || "";
      const apiMessage = errorJson?.error?.message || `HTTP ${response.status}`;

      if (
        response.status === 403 &&
        (reason === "quotaExceeded" || reason === "dailyLimitExceeded")
      ) {
        quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
        logger.error(
          "YOUTUBE",
          `Kuota YouTube Data API habis (${reason}). Mengaktifkan cooldown 30 menit.`,
          { endpoint, reason, totalQuotaUnitsUsed }
        );
        throw new Error("Kuota YouTube Data API v3 telah mencapai batas harian (quotaExceeded).");
      }

      const isTransient = [429, 500, 502, 503, 504].includes(response.status);
      if (isTransient && attempt <= maxRetries) {
        const delayMs = attempt * 1000;
        logger.warn(
          "YOUTUBE",
          `Status ${response.status} pada ${endpoint}, mencoba ulang dalam ${delayMs}ms...`,
          { endpoint, status: response.status, attempt }
        );
        await sleep(delayMs);
        continue;
      }

      throw new Error(sanitizeErrorMessage(`YouTube API error (${response.status}): ${apiMessage}`));
    } catch (error) {
      const isAbortOrNetwork =
        error.name === "TimeoutError" || error.name === "AbortError" || error.name === "TypeError";
      if (isAbortOrNetwork && attempt <= maxRetries) {
        const delayMs = attempt * 1000;
        await sleep(delayMs);
        continue;
      }
      throw new Error(sanitizeErrorMessage(error.message));
    }
  }
}

export async function resolveYouTubeChannel(rawInput) {
  const parsed = parseYouTubeInput(rawInput);

  let data = null;

  if (parsed.type === "channelId") {
    data = await callYouTubeApi(
      "channels",
      { part: "id,snippet,contentDetails", id: parsed.value },
      1
    );
  } else if (parsed.type === "handle") {
    data = await callYouTubeApi(
      "channels",
      { part: "id,snippet,contentDetails", forHandle: parsed.value },
      1
    );

    if ((!data?.items || data.items.length === 0) && parsed.fallbackUsername) {
      data = await callYouTubeApi(
        "channels",
        { part: "id,snippet,contentDetails", forUsername: parsed.fallbackUsername },
        1
      );
    }
  }

  const channel = data?.items?.[0];
  if (!channel?.id) {
    throw new Error(
      "Channel YouTube tidak ditemukan. Pastikan @handle, URL channel, atau Channel ID benar dan bersifat publik."
    );
  }

  const customUrl = channel.snippet?.customUrl || null;
  const displayUsername = customUrl || channel.snippet?.title || channel.id;
  const profileUrl = customUrl
    ? `https://www.youtube.com/${customUrl.startsWith("@") ? customUrl : `@${customUrl}`}`
    : `https://www.youtube.com/channel/${channel.id}`;

  return {
    platform: "youtube",
    platformUserId: channel.id,
    username: displayUsername,
    displayName: channel.snippet?.title || displayUsername,
    profileUrl,
    avatarUrl:
      channel.snippet?.thumbnails?.high?.url ||
      channel.snippet?.thumbnails?.default?.url ||
      null,
    uploadsPlaylistId:
      channel.contentDetails?.relatedPlaylists?.uploads ||
      channel.id.replace(/^UC/, "UU"),
  };
}

function getUploadsPlaylistId(channelId) {
  if (typeof channelId === "string" && channelId.startsWith("UC")) {
    return `UU${channelId.slice(2)}`;
  }
  return null;
}

async function discoverLiveVideoIdFromCanonical(channelId) {
  try {
    const response = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
      signal: AbortSignal.timeout(6000),
    });

    if (!response.ok) return null;

    const html = await response.text();
    const canonicalMatch = html.match(
      /<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/i
    );
    if (canonicalMatch?.[1]) {
      return canonicalMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchPublicFeedEntries(channelId) {
  try {
    const response = await fetch(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}&_=${Date.now()}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Pragma: "no-cache",
        },
        signal: AbortSignal.timeout(6000),
      }
    );

    if (!response.ok) return [];

    const xml = await response.text();
    const entryBlocks = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(
      (m) => m[1]
    );

    const entries = [];
    for (const block of entryBlocks.slice(0, 8)) {
      const videoId = block.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1];
      if (!videoId) continue;

      const title =
        block
          .match(/<title>([\s\S]*?)<\/title>/)?.[1]
          ?.replaceAll("&amp;", "&")
          ?.replaceAll("&quot;", '"')
          ?.replaceAll("&#39;", "'")
          ?.replaceAll("&lt;", "<")
          ?.replaceAll("&gt;", ">") || "";
      const published = block.match(/<published>([\s\S]*?)<\/published>/)?.[1] || null;
      const link =
        block.match(/<link\s+rel="alternate"\s+href="([^"]+)"/i)?.[1] ||
        `https://www.youtube.com/watch?v=${videoId}`;

      entries.push({ videoId, title, published, link });
    }

    return entries;
  } catch {
    return [];
  }
}

async function discoverVideoIdsFromPublicFeed(channelId) {
  const entries = await fetchPublicFeedEntries(channelId);
  return entries.slice(0, 5).map((e) => e.videoId);
}

async function fetchRecentCandidateVideoIds(channelId) {
  const candidates = new Set();

  const [canonicalVideoId, feedVideoIds] = await Promise.all([
    discoverLiveVideoIdFromCanonical(channelId),
    discoverVideoIdsFromPublicFeed(channelId),
  ]);

  if (canonicalVideoId) {
    finishedVideoIds.delete(canonicalVideoId);
    candidates.add(canonicalVideoId);
  }

  for (const vid of feedVideoIds) {
    if (!finishedVideoIds.has(vid)) {
      candidates.add(vid);
    }
  }

  if (candidates.size === 0 && feedVideoIds.length === 0) {
    const uploadsPlaylistId = getUploadsPlaylistId(channelId);
    if (uploadsPlaylistId) {
      try {
        const playlistData = await callYouTubeApi(
          "playlistItems",
          {
            part: "contentDetails,snippet",
            playlistId: uploadsPlaylistId,
            maxResults: 5,
          },
          1
        );

        for (const item of playlistData?.items || []) {
          const videoId =
            item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
          if (videoId && !finishedVideoIds.has(videoId)) {
            candidates.add(videoId);
          }
        }
      } catch (error) {
        if (!error.message.includes("404")) {
          throw error;
        }
      }
    }
  }

  return Array.from(candidates);
}

export async function checkYouTubeAccountsLive(accounts = [], { force = false } = {}) {
  const results = new Map();

  if (!config.youtube.apiKey) {
    logger.warn(
      "YOUTUBE",
      "YOUTUBE_API_KEY kosong, melewati pemeriksaan YouTube."
    );
    return results;
  }

  if (Date.now() < quotaCooldownUntil) {
    logger.warn(
      "YOUTUBE",
      "Melewati pemeriksaan karena kuota sedang dalam masa cooldown."
    );
    return results;
  }

  const now = Date.now();
  const eligibleAccounts = accounts.filter((acc) => {
    if (acc.platform !== "youtube" || !acc.platform_user_id || acc.is_active === false) {
      return false;
    }
    if (force) return true;
    const lastCheck = lastCheckedMap.get(acc.id) || 0;
    return now - lastCheck >= MIN_CHECK_INTERVAL_MS;
  });

  if (eligibleAccounts.length === 0) {
    return results;
  }

  if (lastCheckedMap.size > 500) {
    lastCheckedMap.clear();
  }

  const allCandidateVideoIds = new Set();

  await Promise.all(
    eligibleAccounts.map(async (account) => {
      try {
        const videoIds = await fetchRecentCandidateVideoIds(account.platform_user_id);
        lastCheckedMap.set(account.id, Date.now());
        for (const vid of videoIds) {
          allCandidateVideoIds.add(vid);
        }
      } catch (error) {
        logger.error(
          "YOUTUBE",
          `Gagal memeriksa kandidat video untuk ${account.username}: ${error.message}`,
          { accountId: account.id, username: account.username }
        );
        results.set(account.id, {
          isLive: false,
          available: false,
          error: error.message,
        });
      }
    })
  );

  const videoIdArray = Array.from(allCandidateVideoIds);
  const liveVideoByChannelId = new Map();

  for (let i = 0; i < videoIdArray.length; i += 50) {
    const batchIds = videoIdArray.slice(i, i + 50);
    try {
      const videosData = await callYouTubeApi(
        "videos",
        {
          part: "id,snippet,liveStreamingDetails",
          id: batchIds.join(","),
        },
        1
      );

      for (const video of videosData?.items || []) {
        const broadcastContent = video.snippet?.liveBroadcastContent || "none";
        const isLiveBroadcast = broadcastContent === "live";
        const hasActiveStreamTime =
          Boolean(video.liveStreamingDetails?.actualStartTime) &&
          !video.liveStreamingDetails?.actualEndTime;

        if ((isLiveBroadcast || hasActiveStreamTime) && video.snippet?.channelId) {
          liveVideoByChannelId.set(video.snippet.channelId, {
            isLive: true,
            available: true,
            streamId: video.id,
            title: String(
              video.snippet.title || `${video.snippet.channelTitle} LIVE STREAM`
            ).toUpperCase(),
            streamUrl: `https://www.youtube.com/watch?v=${video.id}`,
            thumbnailUrl:
              video.snippet.thumbnails?.maxres?.url ||
              video.snippet.thumbnails?.high?.url ||
              video.snippet.thumbnails?.medium?.url ||
              null,
            startedAt:
              video.liveStreamingDetails?.actualStartTime || new Date().toISOString(),
            channelTitle: video.snippet.channelTitle || null,
          });
        } else if (
          broadcastContent === "none" &&
          (!video.liveStreamingDetails || video.liveStreamingDetails.actualEndTime)
        ) {
          if (finishedVideoIds.size > 500) {
            finishedVideoIds.clear();
          }
          finishedVideoIds.add(video.id);
        }
      }
    } catch (error) {
      logger.error(
        "YOUTUBE",
        `Gagal memverifikasi batch video: ${error.message}`,
        { batchSize: batchIds.length }
      );
    }
  }

  for (const account of eligibleAccounts) {
    if (results.has(account.id)) continue;

    const liveInfo = liveVideoByChannelId.get(account.platform_user_id);
    if (liveInfo) {
      results.set(account.id, liveInfo);
    } else {
      results.set(account.id, {
        isLive: false,
        available: true,
      });
    }
  }

  return results;
}

export async function checkYouTubeAccountsContent(
  accounts = [],
  { sinceTimestampMs = Date.now(), force = false } = {}
) {
  const results = new Map();

  if (!config.youtube.apiKey || Date.now() < quotaCooldownUntil) {
    return results;
  }

  const now = Date.now();
  const eligibleAccounts = accounts.filter((acc) => {
    if (acc.platform !== "youtube" || !acc.platform_user_id || acc.is_active === false) {
      return false;
    }
    if (force) return true;
    const lastCheck = lastContentCheckedMap.get(acc.id) || 0;
    return now - lastCheck >= CONTENT_CHECK_INTERVAL_MS;
  });

  if (eligibleAccounts.length === 0) {
    return results;
  }

  if (lastContentCheckedMap.size > 500) {
    lastContentCheckedMap.clear();
  }
  if (seenContentVideoIds.size > 1000) {
    seenContentVideoIds.clear();
  }

  const candidateByVideoId = new Map();

  await Promise.all(
    eligibleAccounts.map(async (account) => {
      const entries = await fetchPublicFeedEntries(account.platform_user_id);
      lastContentCheckedMap.set(account.id, Date.now());

      const nowMs = Date.now();
      const accountCreatedMs = account.created_at
        ? Date.parse(account.created_at)
        : 0;
      const isBaselined = baselinedYouTubeAccounts.has(account.id);
      const cutoffMs = isBaselined
        ? Math.max(nowMs - MAX_POST_AGE_AFTER_BASELINE_MS, accountCreatedMs || 0)
        : Math.max(
            sinceTimestampMs,
            nowMs - INITIAL_BASELINE_RECENT_WINDOW_MS,
            accountCreatedMs || 0
          );

      for (const entry of entries) {
        if (seenContentVideoIds.has(entry.videoId)) continue;

        const publishedMs = entry.published ? Date.parse(entry.published) : 0;
        if (!publishedMs || publishedMs < cutoffMs) {
          seenContentVideoIds.add(entry.videoId);
          continue;
        }

        candidateByVideoId.set(entry.videoId, { account, entry });
      }

      if (entries.length > 0) {
        baselinedYouTubeAccounts.add(account.id);
      }
    })
  );

  const videoIdArray = Array.from(candidateByVideoId.keys());
  if (videoIdArray.length === 0) {
    return results;
  }

  for (let i = 0; i < videoIdArray.length; i += 50) {
    const batchIds = videoIdArray.slice(i, i + 50);
    try {
      const videosData = await callYouTubeApi(
        "videos",
        {
          part: "id,snippet,liveStreamingDetails",
          id: batchIds.join(","),
        },
        1
      );

      for (const video of videosData?.items || []) {
        seenContentVideoIds.add(video.id);

        const isLiveOrStream =
          Boolean(video.liveStreamingDetails) ||
          (video.snippet?.liveBroadcastContent &&
            video.snippet.liveBroadcastContent !== "none");

        if (isLiveOrStream) {
          continue;
        }

        const candidate = candidateByVideoId.get(video.id);
        if (!candidate) continue;

        const { account, entry } = candidate;
        const list = results.get(account.id) || [];
        list.push({
          contentId: video.id,
          title: String(
            video.snippet?.title || entry.title || `${account.username} NEW VIDEO`
          ).toUpperCase(),
          contentUrl: entry.link || `https://www.youtube.com/watch?v=${video.id}`,
          thumbnailUrl:
            video.snippet?.thumbnails?.maxres?.url ||
            video.snippet?.thumbnails?.high?.url ||
            video.snippet?.thumbnails?.medium?.url ||
            `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
          publishedAt:
            video.snippet?.publishedAt ||
            entry.published ||
            new Date().toISOString(),
        });
        results.set(account.id, list);
      }
    } catch (error) {
      logger.error(
        "YOUTUBE",
        `Gagal memverifikasi batch konten: ${error.message}`,
        { batchSize: batchIds.length }
      );
    }
  }

  return results;
}
