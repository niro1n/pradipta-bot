import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedBuilder } from "discord.js";
import config from "../config/config.js";
import supabase from "./database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, "..", "..", "logs");
const SYSTEM_LOG_FILE = path.join(LOG_DIR, "system.log");
const ERROR_LOG_FILE = path.join(LOG_DIR, "error.log");

const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MEMORY_LOGS = 200;
const DEDUPE_WINDOW_MS = 3 * 60 * 1000;
const DB_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const DB_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DB_RETENTION_DAYS = 14;

const recentLogs = [];
const dedupeMap = new Map();
let logDirReady = false;
let discordClient = null;
let dbTableAvailable = true;
let dbRetryAfter = 0;
let lastPruneAt = 0;

function getSecretsList() {
  return [
    config.discord?.token,
    config.supabase?.secretKey,
    config.supabase?.publishableKey,
    config.youtube?.apiKey,
  ].filter((s) => typeof s === "string" && s.length >= 8);
}

export function sanitizeLogText(input) {
  if (input === null || input === undefined) return "";
  let text =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? input.message || String(input)
        : String(input);

  for (const secret of getSecretsList()) {
    text = text.replaceAll(secret, "[REDACTED]");
  }
  return text;
}

function sanitizeMetadata(meta) {
  if (!meta || typeof meta !== "object") return null;
  try {
    const raw = JSON.stringify(meta, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: sanitizeLogText(value.message),
          code: value.code || undefined,
        };
      }
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    });
    if (!raw || raw === "{}") return null;
    return JSON.parse(sanitizeLogText(raw));
  } catch {
    return null;
  }
}

function shouldThrottle(level, category, message) {
  const now = Date.now();
  if (dedupeMap.size > 500) {
    for (const [k, expiresAt] of dedupeMap.entries()) {
      if (now > expiresAt) dedupeMap.delete(k);
    }
  }

  const key = `${level}:${category}:${message}`;
  const expiresAt = dedupeMap.get(key) || 0;
  if (now < expiresAt) {
    return true;
  }

  dedupeMap.set(key, now + DEDUPE_WINDOW_MS);
  return false;
}

async function ensureLogDir() {
  if (logDirReady) return;
  await mkdir(LOG_DIR, { recursive: true });
  logDirReady = true;
}

async function rotateIfNeeded(filePath) {
  try {
    const info = await stat(filePath);
    if (info.size >= MAX_LOG_FILE_BYTES) {
      await rename(filePath, `${filePath}.1`).catch(() => {});
    }
  } catch {}
}

async function writeToFileLog(entry) {
  try {
    await ensureLogDir();
    const line = `${JSON.stringify(entry)}\n`;

    await rotateIfNeeded(SYSTEM_LOG_FILE);
    await appendFile(SYSTEM_LOG_FILE, line, "utf8");

    if (entry.level === "error" || entry.level === "warn") {
      await rotateIfNeeded(ERROR_LOG_FILE);
      await appendFile(ERROR_LOG_FILE, line, "utf8");
    }
  } catch {}
}

async function pruneOldDatabaseLogs() {
  const now = Date.now();
  if (now - lastPruneAt < DB_PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  const cutoffIso = new Date(
    now - DB_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  await supabase
    .from("system_logs")
    .delete()
    .lt("created_at", cutoffIso)
    .catch(() => {});
}

async function writeToDatabaseLog(entry) {
  const now = Date.now();
  if (!dbTableAvailable && now < dbRetryAfter) {
    return;
  }

  try {
    const { error } = await supabase.from("system_logs").insert({
      level: entry.level,
      category: entry.category,
      message: entry.message,
      metadata: entry.metadata,
      created_at: entry.timestamp,
    });

    if (error) {
      if (
        error.code === "PGRST205" ||
        error.code === "42P01" ||
        String(error.message || "").includes("system_logs")
      ) {
        dbTableAvailable = false;
        dbRetryAfter = now + DB_RETRY_COOLDOWN_MS;
      }
      return;
    }

    dbTableAvailable = true;
    pruneOldDatabaseLogs().catch(() => {});
  } catch {}
}

async function forwardToDiscordLogChannel(entry) {
  const logChannelId = config.channels?.logChannelId;
  if (!logChannelId || !discordClient?.isReady?.()) return;
  if (entry.level !== "error" && entry.level !== "warn") return;

  try {
    const channel =
      discordClient.channels.cache.get(logChannelId) ??
      (await discordClient.channels.fetch(logChannelId).catch(() => null));

    if (!channel || !channel.isTextBased()) return;

    const color = entry.level === "error" ? 0xed4245 : 0xfee75c;
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${entry.level.toUpperCase()} • ${entry.category}`)
      .setDescription(entry.message.slice(0, 2000))
      .setTimestamp(new Date(entry.timestamp));

    if (entry.metadata) {
      const metaText = JSON.stringify(entry.metadata).slice(0, 1000);
      embed.addFields({
        name: "METADATA",
        value: `\`\`\`json\n${metaText}\n\`\`\``,
      });
    }

    await channel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  } catch {}
}

function recordEntry(
  level,
  category,
  rawMessage,
  metadata = null,
  { persistDb = level !== "info" } = {}
) {
  const timestamp = new Date().toISOString();
  const cleanCategory = String(category || "SYSTEM")
    .replace(/^\[|\]$/g, "")
    .trim()
    .toUpperCase();
  const message = sanitizeLogText(rawMessage);
  const cleanMeta = sanitizeMetadata(metadata);

  const entry = {
    timestamp,
    level,
    category: cleanCategory,
    message,
    metadata: cleanMeta,
  };

  if (recentLogs.length >= MAX_MEMORY_LOGS) {
    recentLogs.shift();
  }
  recentLogs.push(entry);

  const metaSuffix = cleanMeta ? ` | ${JSON.stringify(cleanMeta)}` : "";
  const formattedLine = `[${cleanCategory}] ${message}${metaSuffix}`;

  if (level === "error") {
    console.error(formattedLine);
  } else if (level === "warn") {
    console.warn(formattedLine);
  } else {
    console.log(formattedLine);
  }

  const throttled =
    (level === "error" || level === "warn") &&
    shouldThrottle(level, cleanCategory, message);

  writeToFileLog(entry).catch(() => {});

  if (persistDb && !throttled) {
    writeToDatabaseLog(entry).catch(() => {});
  }

  if ((level === "error" || level === "warn") && !throttled) {
    forwardToDiscordLogChannel(entry).catch(() => {});
  }

  return entry;
}

export function attachLoggerClient(client) {
  discordClient = client;
}

export function getRecentLogs({ level = null, category = null, limit = 50 } = {}) {
  let list = recentLogs;
  if (level) {
    list = list.filter((item) => item.level === level);
  }
  if (category) {
    const target = category.toUpperCase();
    list = list.filter((item) => item.category === target);
  }
  return list.slice(-Math.max(1, limit));
}

export const logger = {
  info(category, message, metadata = null, options = {}) {
    return recordEntry("info", category, message, metadata, options);
  },
  warn(category, message, metadata = null, options = {}) {
    return recordEntry("warn", category, message, metadata, {
      persistDb: true,
      ...options,
    });
  },
  error(category, message, metadata = null, options = {}) {
    return recordEntry("error", category, message, metadata, {
      persistDb: true,
      ...options,
    });
  },
};

export default logger;
