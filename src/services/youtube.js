import config from "../config/config.js";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 8000;
const MIN_CHECK_INTERVAL_MS = 60 * 1000;
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;

let quotaCooldownUntil = 0;
let totalQuotaUnitsUsed = 0;
let totalApiRequests = 0;
const lastCheckedMap = new Map();

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
        console.log(
          `[YouTube API] ${endpoint} | cost=${quotaCost} | totalUnits=${totalQuotaUnitsUsed}`
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
        console.error(
          `[YouTube API] Kuota YouTube Data API habis (${reason}). Mengaktifkan cooldown 30 menit.`
        );
        throw new Error("Kuota YouTube Data API v3 telah mencapai batas harian (quotaExceeded).");
      }

      const isTransient = [429, 500, 502, 503, 504].includes(response.status);
      if (isTransient && attempt <= maxRetries) {
        const delayMs = attempt * 1000;
        console.warn(
          `[YouTube API] Status ${response.status} pada ${endpoint}, mencoba ulang dalam ${delayMs}ms...`
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

async function fetchRecentCandidateVideoIds(channelId) {
  const candidates = new Set();

  const canonicalVideoId = await discoverLiveVideoIdFromCanonical(channelId);
  if (canonicalVideoId) {
    candidates.add(canonicalVideoId);
  }

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
        const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
        if (videoId) {
          candidates.add(videoId);
        }
      }
    } catch (error) {
      if (!error.message.includes("404")) {
        throw error;
      }
    }
  }

  return Array.from(candidates);
}

export async function checkYouTubeAccountsLive(accounts = [], { force = false } = {}) {
  const results = new Map();

  if (!config.youtube.apiKey) {
    console.warn("[YouTube Monitor] YOUTUBE_API_KEY kosong, melewati pemeriksaan YouTube.");
    return results;
  }

  if (Date.now() < quotaCooldownUntil) {
    console.warn("[YouTube Monitor] Melewati pemeriksaan karena kuota sedang dalam masa cooldown.");
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

  const accountCandidatesMap = new Map();
  const allCandidateVideoIds = new Set();

  for (const account of eligibleAccounts) {
    try {
      const videoIds = await fetchRecentCandidateVideoIds(account.platform_user_id);
      lastCheckedMap.set(account.id, Date.now());
      accountCandidatesMap.set(account.id, videoIds);
      for (const vid of videoIds) {
        allCandidateVideoIds.add(vid);
      }
    } catch (error) {
      console.error(
        `[YouTube Monitor] Gagal memeriksa kandidat video untuk ${account.username}: ${error.message}`
      );
      results.set(account.id, {
        isLive: false,
        available: false,
        error: error.message,
      });

      if (Date.now() < quotaCooldownUntil) {
        break;
      }
    }
  }

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
        const isLiveBroadcast = video.snippet?.liveBroadcastContent === "live";
        const hasActiveStreamTime =
          Boolean(video.liveStreamingDetails?.actualStartTime) &&
          !video.liveStreamingDetails?.actualEndTime;

        if ((isLiveBroadcast || hasActiveStreamTime) && video.snippet?.channelId) {
          liveVideoByChannelId.set(video.snippet.channelId, {
            isLive: true,
            available: true,
            streamId: video.id,
            title: video.snippet.title || `${video.snippet.channelTitle} Live Stream`,
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
        }
      }
    } catch (error) {
      console.error(`[YouTube Monitor] Gagal memverifikasi batch video: ${error.message}`);
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
