const REQUEST_TIMEOUT_MS = 8000;
const MIN_CHECK_INTERVAL_MS = 30 * 1000;
const lastCheckedMap = new Map();

const PUBLIC_HTML_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
};

const PUBLIC_API_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
  Referer: "https://www.tiktok.com/",
};

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
  const apiUrl = `https://www.tiktok.com/api-live/user/room/?aid=1988&sourceType=54&uniqueId=${encodeURIComponent(cleanUsername)}`;
  const response = await fetch(apiUrl, {
    headers: PUBLIC_API_HEADERS,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const payload = await response.json();
  return {
    ok: true,
    statusCode: Number(payload?.statusCode ?? 0),
    message: payload?.message || "",
    user: payload?.data?.user || null,
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

export async function resolveTikTokAccount(rawInput) {
  const parsed = parseTikTokInput(rawInput);

  try {
    const apiResult = await fetchTikTokLiveRoomApi(parsed.username);
    if (apiResult.ok) {
      if (
        apiResult.statusCode === 10202 ||
        apiResult.statusCode === 10221 ||
        apiResult.statusCode === 10222 ||
        apiResult.message === "user_not_found"
      ) {
        throw new Error(`Akun TikTok ${parsed.handle} tidak ditemukan.`);
      }

      const user = apiResult.user;
      if (user?.id || user?.uniqueId) {
        const uniqueId = (user.uniqueId || parsed.username).toLowerCase();
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

        if (statusCode === 10202 || statusCode === 10221 || statusCode === 10222) {
          throw new Error(`Akun TikTok ${parsed.handle} tidak ditemukan.`);
        }

        const user = userDetail?.userInfo?.user;
        if (user?.id || user?.uniqueId) {
          const uniqueId = (user.uniqueId || parsed.username).toLowerCase();
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

function buildLiveResultFromRoom({ account, liveUrl, user, liveRoom }) {
  const roomId = user?.roomId || liveRoom?.roomId || null;
  const status = Number(liveRoom?.status ?? user?.status ?? 0);

  if (roomId && status === 2) {
    const startTimeSec = Number(liveRoom?.startTime);
    const uniqueStreamId = String(
      liveRoom?.streamId || (startTimeSec > 0 ? `${roomId}_${startTimeSec}` : roomId)
    );

    return {
      isLive: true,
      available: true,
      streamId: uniqueStreamId,
      title: String(
        liveRoom?.title || `${account.username} SEDANG LIVE DI TIKTOK!`
      ).toUpperCase(),
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
    const apiResult = await fetchTikTokLiveRoomApi(cleanUsername);
    if (apiResult.ok && (apiResult.user || apiResult.liveRoom)) {
      return buildLiveResultFromRoom({
        account,
        liveUrl,
        user: apiResult.user,
        liveRoom: apiResult.liveRoom,
      });
    }
  } catch {}

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

  const eligibleAccounts = accounts.filter((acc) => {
    if (acc.platform !== "tiktok" || acc.is_active === false) {
      return false;
    }
    if (force) return true;
    const lastCheck = lastCheckedMap.get(acc.id) || 0;
    return now - lastCheck >= MIN_CHECK_INTERVAL_MS;
  });

  for (const account of eligibleAccounts) {
    const res = await checkTikTokAccountLive(account);
    lastCheckedMap.set(account.id, Date.now());
    results.set(account.id, res);
  }

  return results;
}
