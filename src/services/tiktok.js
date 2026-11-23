import logger from "./logger.js";

const REQUEST_TIMEOUT_MS = 8000;
const MIN_CHECK_INTERVAL_MS = 20 * 1000;
const CONTENT_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_POST_AGE_AFTER_BASELINE_MS = 24 * 60 * 60 * 1000;
const INITIAL_BASELINE_RECENT_WINDOW_MS = 15 * 60 * 1000;
const LIVE_BATCH_SIZE_PER_TICK = 5;
const CONTENT_BATCH_SIZE_PER_TICK = 3;
const CONCURRENCY_LIMIT = 2;
const REQUEST_STAGGER_MS = 150;

const lastCheckedMap = new Map();
const lastContentCheckedMap = new Map();
const secUidByUsername = new Map();
const seenTikTokContentIds = new Set();
const baselinedTikTokAccounts = new Set();

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
};

const PUBLIC_HTML_HEADERS = {
  ...BASE_HEADERS,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const PUBLIC_API_HEADERS = {
  ...BASE_HEADERS,
  Accept: "application/json, text/plain, */*",
  Referer: "https://www.tiktok.com/",
};

const NOT_FOUND_CODES = new Set([10202, 10221, 10222]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeParseJsonResponse(response) {
  const text = await response.text();
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item !== undefined) {
          await worker(item);
          if (queue.length > 0 && REQUEST_STAGGER_MS > 0) {
            await sleep(REQUEST_STAGGER_MS);
          }
        }
      }
    }
  );
  await Promise.all(runners);
}

export function parseTikTokInput(rawInput) {
  const input = typeof rawInput === "string" ? rawInput.trim() : "";

  if (!input) {
    throw new Error("Input akun TikTok tidak boleh kosong.");
  }

  if (/youtube\.com|youtu\.be/i.test(input)) {
    throw new Error("URL yang dimasukkan adalah URL YouTube, bukan TikTok.");
  }

  if (/^https?:\/\//i.test(input) || /^(www\.|m\.|vt\.|vm\.)?tiktok\.com\//i.test(input)) {
    const normalizedUrl = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    let parsedUrl;

    try {
      parsedUrl = new URL(normalizedUrl);
    } catch {
      throw new Error("Format URL TikTok tidak valid.");
    }

    const host = parsedUrl.hostname.toLowerCase();
    if (host === "vt.tiktok.com" || host === "vm.tiktok.com") {
      throw new Error(
        "Gunakan URL profil lengkap (https://www.tiktok.com/@username) atau @username, bukan shortlink."
      );
    }

    if (!["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host)) {
      throw new Error("Domain URL harus berasal dari tiktok.com.");
    }

    const segments = parsedUrl.pathname.split("/").filter(Boolean);
    const first = segments[0] ? decodeURIComponent(segments[0]) : "";

    if (!first.startsWith("@")) {
      throw new Error(
        "URL profil TikTok harus memuat @username (contoh: https://www.tiktok.com/@username)."
      );
    }

    const cleanUsername = first.slice(1).toLowerCase();
    if (!/^[a-zA-Z0-9._]{2,24}$/.test(cleanUsername)) {
      throw new Error("Username TikTok pada URL tidak valid.");
    }

    return {
      username: cleanUsername,
      handle: `@${cleanUsername}`,
      profileUrl: `https://www.tiktok.com/@${cleanUsername}`,
    };
  }

  const cleanUsername = input.replace(/^@/, "").toLowerCase();
  if (!/^[a-zA-Z0-9._]{2,24}$/.test(cleanUsername)) {
    throw new Error(
      "Format username TikTok tidak valid. Gunakan @username atau https://www.tiktok.com/@username (2-24 karakter huruf, angka, titik, atau garis bawah)."
    );
  }

  return {
    username: cleanUsername,
    handle: `@${cleanUsername}`,
    profileUrl: `https://www.tiktok.com/@${cleanUsername}`,
  };
}

async function fetchTikTokLiveRoomApi(cleanUsername) {
  const apiUrl = `https://www.tiktok.com/api-live/user/room/?aid=1988&sourceType=54&uniqueId=${encodeURIComponent(cleanUsername)}&_=${Date.now()}`;
  const response = await fetch(apiUrl, {
    headers: PUBLIC_API_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const payload = await safeParseJsonResponse(response);
  if (!payload) {
    return { ok: false, status: 204 };
  }

  const user = payload?.data?.user || null;

  if (user?.secUid) {
    if (secUidByUsername.size > 500) {
      secUidByUsername.clear();
    }
    secUidByUsername.set(cleanUsername, user.secUid);
  }

  return {
    ok: true,
    statusCode: Number(payload?.statusCode ?? 0),
    message: payload?.message || "",
    user,
    liveRoom: payload?.data?.liveRoom || null,
  };
}

function extractRehydrationJson(html) {
  if (!html || typeof html !== "string") return null;

  const universalMatch = html.match(
    /<script\s+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (universalMatch?.[1]) {
    try {
      return { type: "universal", data: JSON.parse(universalMatch[1]) };
    } catch {}
  }

  const sigiMatch = html.match(/<script\s+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i);
  if (sigiMatch?.[1]) {
    try {
      return { type: "sigi", data: JSON.parse(sigiMatch[1]) };
    } catch {}
  }

  return null;
}

function formatResolvedTikTokUser(user, fallbackUsername) {
  const uniqueId = (user.uniqueId || fallbackUsername).toLowerCase();
  if (user.secUid) {
    secUidByUsername.set(uniqueId, user.secUid);
  }
  return {
    platform: "tiktok",
    platformUserId: String(user.id || uniqueId),
    username: `@${uniqueId}`,
    displayName: user.nickname || `@${uniqueId}`,
    profileUrl: `https://www.tiktok.com/@${uniqueId}`,
    avatarUrl: user.avatarLarger || user.avatarMedium || null,
    verifiedViaPublicPage: true,
  };
}

export async function resolveTikTokAccount(rawInput) {
  const parsed = parseTikTokInput(rawInput);

  try {
    const apiResult = await fetchTikTokLiveRoomApi(parsed.username);
    if (apiResult.ok) {
      if (
        NOT_FOUND_CODES.has(apiResult.statusCode) ||
        apiResult.message === "user_not_found"
      ) {
        throw new Error(`Akun TikTok ${parsed.handle} tidak ditemukan.`);
      }

      if (apiResult.user?.id || apiResult.user?.uniqueId) {
        return formatResolvedTikTokUser(apiResult.user, parsed.username);
      }
    }
  } catch (error) {
    if (error.message.includes("tidak ditemukan")) {
      throw error;
    }
  }

  try {
    const response = await fetch(parsed.profileUrl, {
      headers: PUBLIC_HTML_HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      const html = await response.text();
      const extracted = extractRehydrationJson(html);

      if (extracted?.type === "universal") {
        const userDetail =
          extracted.data?.__DEFAULT_SCOPE__?.["webapp.user-detail"];
        const statusCode = Number(userDetail?.statusCode ?? 0);

        if (NOT_FOUND_CODES.has(statusCode)) {
          throw new Error(`Akun TikTok ${parsed.handle} tidak ditemukan.`);
        }

        const user = userDetail?.userInfo?.user;
        if (user?.id || user?.uniqueId) {
          return formatResolvedTikTokUser(user, parsed.username);
        }
      }
    }
  } catch (error) {
    if (error.message.includes("tidak ditemukan")) {
      throw error;
    }
  }

  return {
    platform: "tiktok",
    platformUserId: parsed.username,
    username: parsed.handle,
    displayName: parsed.handle,
    profileUrl: parsed.profileUrl,
    avatarUrl: null,
    verifiedViaPublicPage: false,
  };
}

function decodeTikTokVideoTimestampMs(videoId) {
  try {
    if (!/^\d{15,22}$/.test(String(videoId))) return 0;
    const sec = Number(BigInt(videoId) >> 32n);
    if (!Number.isFinite(sec) || sec <= 1500000000) return 0;
    return sec * 1000;
  } catch {
    return 0;
  }
}

function buildLiveResultFromRoom({ account, liveUrl, user, liveRoom }) {
  const roomId = String(user?.roomId || liveRoom?.roomId || "").trim();
  const isLiveStatus =
    Number(liveRoom?.status) === 2 || Number(user?.status) === 2;

  if (roomId && isLiveStatus) {
    const startTimeSec = Number(liveRoom?.startTime);
    const roomTimestampMs = decodeTikTokVideoTimestampMs(roomId);
    const uniqueStreamId = String(roomId || liveRoom?.streamId);
    const rawTitle = String(liveRoom?.title || "").trim();

    return {
      isLive: true,
      available: true,
      streamId: uniqueStreamId,
      title: (
        rawTitle || `${account.username} SEDANG LIVE DI TIKTOK!`
      ).toUpperCase(),
      hasCustomTitle: Boolean(rawTitle),
      streamUrl: liveUrl,
      thumbnailUrl:
        liveRoom?.coverUrl ||
        liveRoom?.squareCoverImg ||
        user?.avatarLarger ||
        user?.avatarMedium ||
        null,
      startedAt:
        Number.isFinite(startTimeSec) && startTimeSec > 0
          ? new Date(startTimeSec * 1000).toISOString()
          : roomTimestampMs > 0
            ? new Date(roomTimestampMs).toISOString()
            : new Date().toISOString(),
    };
  }

  return {
    isLive: false,
    available: true,
  };
}

export async function checkTikTokAccountLive(account) {
  const cleanUsername = String(account.username || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();

  if (!cleanUsername) {
    return { isLive: false, available: false, reason: "Missing TikTok username" };
  }

  const liveUrl = `https://www.tiktok.com/@${cleanUsername}/live`;

  try {
    let apiResult = await fetchTikTokLiveRoomApi(cleanUsername);
    if (apiResult.ok && (apiResult.user || apiResult.liveRoom)) {
      const isLiveNow =
        Number(apiResult.liveRoom?.status) === 2 ||
        Number(apiResult.user?.status) === 2;
      const hasRoomTitle = Boolean(String(apiResult.liveRoom?.title || "").trim());

      if (isLiveNow && !hasRoomTitle) {
        await sleep(600);
        const retryResult = await fetchTikTokLiveRoomApi(cleanUsername).catch(
          () => null
        );
        if (retryResult?.ok && (retryResult.user || retryResult.liveRoom)) {
          apiResult = retryResult;
        }
      }

      return buildLiveResultFromRoom({
        account,
        liveUrl,
        user: apiResult.user,
        liveRoom: apiResult.liveRoom,
      });
    }
  } catch (error) {
    const isTimeout =
      error?.name === "TimeoutError" ||
      error?.name === "AbortError" ||
      String(error?.message || "").includes("aborted due to timeout");
    if (!isTimeout) {
      logger.warn(
        "TIKTOK",
        `Gagal memeriksa live room API untuk ${account.username}`,
        {
          username: account.username,
          error: error.message,
        }
      );
    }
  }

  try {
    const response = await fetch(liveUrl, {
      headers: PUBLIC_HTML_HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      return {
        isLive: false,
        available: false,
        reason: `HTTP ${response.status}`,
      };
    }

    const html = await response.text();
    const extracted = extractRehydrationJson(html);

    if (!extracted) {
      return {
        isLive: false,
        available: false,
        reason: "Metadata publik TikTok tidak tersedia pada respons",
      };
    }

    if (extracted.type === "universal") {
      const scope = extracted.data?.__DEFAULT_SCOPE__ || {};
      const liveDetail =
        scope["webapp.live-detail"] ||
        scope["webapp.user-detail"] ||
        null;

      if (!liveDetail) {
        return {
          isLive: false,
          available: false,
          reason: "Scope webapp.live-detail tidak tersedia pada HTML",
        };
      }

      const liveRoom =
        liveDetail?.LiveRoom?.liveRoomUserInfo?.liveRoom ||
        liveDetail?.liveRoomUserInfo?.liveRoom ||
        null;
      const user =
        liveDetail?.LiveRoom?.liveRoomUserInfo?.user ||
        liveDetail?.userInfo?.user ||
        null;

      return buildLiveResultFromRoom({
        account,
        liveUrl,
        user,
        liveRoom,
      });
    }

    if (extracted.type === "sigi") {
      const liveRoom =
        extracted.data?.LiveRoom?.liveRoomUserInfo?.liveRoom || null;
      const user = extracted.data?.LiveRoom?.liveRoomUserInfo?.user || null;

      if (!liveRoom && !user) {
        return {
          isLive: false,
          available: false,
          reason: "SIGI_STATE LiveRoom tidak tersedia",
        };
      }

      return buildLiveResultFromRoom({
        account,
        liveUrl,
        user,
        liveRoom,
      });
    }

    return { isLive: false, available: false, reason: "Unrecognized metadata format" };
  } catch (error) {
    return {
      isLive: false,
      available: false,
      reason: error.message,
    };
  }
}

export async function checkTikTokAccountsLive(accounts = [], { force = false } = {}) {
  const results = new Map();
  const now = Date.now();

  const eligibleAccounts = accounts
    .filter((acc) => {
      if (acc.platform !== "tiktok" || acc.is_active === false) {
        return false;
      }
      if (force) return true;
      const lastCheck = lastCheckedMap.get(acc.id) || 0;
      return now - lastCheck >= MIN_CHECK_INTERVAL_MS;
    })
    .sort(
      (a, b) =>
        (lastCheckedMap.get(a.id) || 0) - (lastCheckedMap.get(b.id) || 0)
    )
    .slice(0, force ? accounts.length : LIVE_BATCH_SIZE_PER_TICK);

  if (lastCheckedMap.size > 500) {
    lastCheckedMap.clear();
  }

  await runWithConcurrency(
    eligibleAccounts,
    CONCURRENCY_LIMIT,
    async (account) => {
      const res = await checkTikTokAccountLive(account);
      lastCheckedMap.set(account.id, Date.now());
      results.set(account.id, res);
    }
  );

  return results;
}

async function fetchTikTokCreatorItemsBySecUid(secUid, cleanUsername) {
  const url = `https://www.tiktok.com/api/creator/item_list/?aid=1988&secUid=${encodeURIComponent(secUid)}&count=10&cursor=${Date.now()}&type=1`;
  const response = await fetch(url, {
    headers: PUBLIC_API_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const data = await safeParseJsonResponse(response);
  if (!Array.isArray(data?.itemList)) return null;

  return data.itemList
    .filter((item) => {
      const authorUniqueId = String(item?.author?.uniqueId || "").toLowerCase();
      return !authorUniqueId || authorUniqueId === cleanUsername;
    })
    .map((item) => ({
      id: String(item.id || "").trim(),
      desc: String(item.desc || "").trim(),
      publishedMs:
        Number(item.createTime) > 0
          ? Number(item.createTime) * 1000
          : decodeTikTokVideoTimestampMs(item.id),
      thumbnailUrl:
        item.video?.originCover ||
        item.video?.cover ||
        item.video?.dynamicCover ||
        null,
    }))
    .filter((item) => Boolean(item.id));
}

async function fetchTikTokCreatorItemsFromEmbed(cleanUsername) {
  const embedUrl = `https://www.tiktok.com/embed/@${encodeURIComponent(cleanUsername)}?_=${Date.now()}`;
  const response = await fetch(embedUrl, {
    headers: PUBLIC_HTML_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) return [];

  const html = await response.text();
  const stateMatch = html.match(
    /<script\s+id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!stateMatch?.[1]) return [];

  const parsedState = JSON.parse(stateMatch[1]);
  const sourceData = parsedState?.source?.data || {};
  const routeData = sourceData[`/embed/@${cleanUsername}`] || null;
  if (!routeData) return [];

  const routeOwner = String(routeData?.userInfo?.uniqueId || "").toLowerCase();
  if (routeOwner && routeOwner !== cleanUsername) {
    return [];
  }

  const videoList = Array.isArray(routeData?.videoList)
    ? routeData.videoList
    : [];

  return videoList
    .map((item) => ({
      id: String(item?.id || "").trim(),
      desc: String(item?.desc || "").trim(),
      publishedMs: decodeTikTokVideoTimestampMs(item?.id),
      thumbnailUrl: item?.originCoverUrl || item?.coverUrl || null,
    }))
    .filter((item) => Boolean(item.id));
}

export async function checkTikTokAccountContent(
  account,
  { sinceTimestampMs = Date.now() } = {}
) {
  const cleanUsername = String(account.username || "")
    .replace(/^@/, "")
    .trim()
    .toLowerCase();

  if (!cleanUsername) return [];

  try {
    let secUid = secUidByUsername.get(cleanUsername) || null;
    if (!secUid) {
      const apiResult = await fetchTikTokLiveRoomApi(cleanUsername).catch(
        () => null
      );
      secUid = apiResult?.user?.secUid || null;
    }

    let items = null;
    if (secUid) {
      items = await fetchTikTokCreatorItemsBySecUid(secUid, cleanUsername).catch(
        () => null
      );
    }

    if (!items || items.length === 0) {
      items = await fetchTikTokCreatorItemsFromEmbed(cleanUsername).catch(
        () => []
      );
    }

    if (!items || items.length === 0) return [];

    const nowMs = Date.now();
    const accountCreatedMs = account.created_at
      ? Date.parse(account.created_at)
      : 0;
    const isBaselined = baselinedTikTokAccounts.has(account.id);

    const cutoffMs = isBaselined
      ? Math.max(nowMs - MAX_POST_AGE_AFTER_BASELINE_MS, accountCreatedMs || 0)
      : Math.max(
          sinceTimestampMs,
          nowMs - INITIAL_BASELINE_RECENT_WINDOW_MS,
          accountCreatedMs || 0
        );

    const newPosts = [];

    for (const item of items) {
      if (seenTikTokContentIds.has(item.id)) continue;

      if (!item.publishedMs || item.publishedMs < cutoffMs) {
        seenTikTokContentIds.add(item.id);
        continue;
      }

      seenTikTokContentIds.add(item.id);

      const title = (
        item.desc || `${account.username} UPLOAD VIDEO BARU DI TIKTOK`
      )
        .slice(0, 240)
        .toUpperCase();

      newPosts.push({
        contentId: item.id,
        title,
        contentUrl: `https://www.tiktok.com/@${cleanUsername}/video/${item.id}`,
        thumbnailUrl: item.thumbnailUrl,
        publishedAt: new Date(item.publishedMs).toISOString(),
      });
    }

    baselinedTikTokAccounts.add(account.id);

    return newPosts.sort(
      (a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt)
    );
  } catch (error) {
    logger.warn("TIKTOK", `Gagal memeriksa konten TikTok ${account.username}`, {
      username: account.username,
      error: error.message,
    });
    return [];
  }
}

export async function checkTikTokAccountsContent(
  accounts = [],
  { sinceTimestampMs = Date.now(), force = false } = {}
) {
  const results = new Map();
  const now = Date.now();

  const eligibleAccounts = accounts
    .filter((acc) => {
      if (acc.platform !== "tiktok" || acc.is_active === false) {
        return false;
      }
      if (force) return true;
      const lastCheck = lastContentCheckedMap.get(acc.id) || 0;
      return now - lastCheck >= CONTENT_CHECK_INTERVAL_MS;
    })
    .sort(
      (a, b) =>
        (lastContentCheckedMap.get(a.id) || 0) -
        (lastContentCheckedMap.get(b.id) || 0)
    )
    .slice(0, force ? accounts.length : CONTENT_BATCH_SIZE_PER_TICK);

  if (eligibleAccounts.length === 0) {
    return results;
  }

  if (lastContentCheckedMap.size > 500) {
    lastContentCheckedMap.clear();
  }
  if (seenTikTokContentIds.size > 2000) {
    seenTikTokContentIds.clear();
  }

  await runWithConcurrency(
    eligibleAccounts,
    CONCURRENCY_LIMIT,
    async (account) => {
      const posts = await checkTikTokAccountContent(account, {
        sinceTimestampMs,
      });
      lastContentCheckedMap.set(account.id, Date.now());
      if (posts.length > 0) {
        results.set(account.id, posts);
      }
    }
  );

  return results;
}
