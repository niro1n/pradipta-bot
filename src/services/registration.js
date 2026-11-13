import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import config from "../config/config.js";
import supabase from "./database.js";
import { resolveYouTubeChannel } from "./youtube.js";
import { resolveTikTokAccount } from "./tiktok.js";

const PANEL_TITLE = "Stream Registration";
const LEGACY_PANEL_TITLES = new Set([
  "Stream Registration",
  "STREAM NOTIFICATION REGISTRATION",
]);

const EMBED_COLOR = 0x2b2d31;
const SUCCESS_COLOR = 0x2ecc71;
const DANGER_COLOR = 0xed4245;

const SELECTION_TTL_MS = 60 * 60 * 1000;
const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const OWNED_ACCOUNT_CACHE_TTL_MS = 30 * 60 * 1000;

export const selectedPlatforms = new Map();
export const pendingRegistrations = new Map();
const ownedAccountsCache = new Map();
const activeEphemeralByUser = new Map();

function pruneExpiredStates() {
  const now = Date.now();
  for (const [key, value] of selectedPlatforms.entries()) {
    if (!value || now > value.expiresAt) {
      selectedPlatforms.delete(key);
    }
  }
  for (const [key, value] of pendingRegistrations.entries()) {
    if (!value || now > value.expiresAt) {
      pendingRegistrations.delete(key);
    }
  }
  for (const [key, value] of ownedAccountsCache.entries()) {
    if (!value || now > value.expiresAt) {
      ownedAccountsCache.delete(key);
    }
  }
}

export async function registerActiveEphemeral(
  discordUserId,
  interaction,
  autoDeleteMs = 0
) {
  if (!discordUserId || !interaction) return;

  const existing = activeEphemeralByUser.get(discordUserId);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    if (existing.interaction && existing.interaction !== interaction) {
      existing.interaction.deleteReply?.().catch(() => {});
    }
  }

  let timer = null;
  if (autoDeleteMs > 0) {
    timer = setTimeout(() => {
      const current = activeEphemeralByUser.get(discordUserId);
      if (current?.interaction === interaction) {
        activeEphemeralByUser.delete(discordUserId);
      }
      interaction.deleteReply?.().catch(() => {});
    }, autoDeleteMs);
    timer.unref?.();
  }

  activeEphemeralByUser.set(discordUserId, { interaction, timer });
}

export function scheduleEphemeralAutoDelete(
  discordUserId,
  interaction,
  autoDeleteMs
) {
  if (!discordUserId || !interaction || autoDeleteMs <= 0) return;

  const existing = activeEphemeralByUser.get(discordUserId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  const targetInteraction = existing?.interaction || interaction;
  const timer = setTimeout(() => {
    const current = activeEphemeralByUser.get(discordUserId);
    if (current?.interaction === targetInteraction) {
      activeEphemeralByUser.delete(discordUserId);
    }
    targetInteraction.deleteReply?.().catch(() => {});
  }, autoDeleteMs);
  timer.unref?.();

  activeEphemeralByUser.set(discordUserId, {
    interaction: targetInteraction,
    timer,
  });
}

export async function handleCloseEphemeral(interaction) {
  await interaction.deferUpdate();
  const existing = activeEphemeralByUser.get(interaction.user.id);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }
  activeEphemeralByUser.delete(interaction.user.id);
  await interaction.deleteReply?.().catch(() => {});
}

export function setSelectedPlatform(discordUserId, platform) {
  pruneExpiredStates();
  selectedPlatforms.set(discordUserId, {
    platform,
    expiresAt: Date.now() + SELECTION_TTL_MS,
  });
}

export function getSelectedPlatform(discordUserId) {
  pruneExpiredStates();
  const entry = selectedPlatforms.get(discordUserId);
  if (!entry || Date.now() > entry.expiresAt) {
    selectedPlatforms.delete(discordUserId);
    return null;
  }
  return entry.platform;
}

export function clearUserRegistrationState(discordUserId) {
  pendingRegistrations.delete(discordUserId);
}

function cacheOwnedAccount(discordUserId, account) {
  if (!discordUserId || !account?.id) return;
  ownedAccountsCache.set(`${discordUserId}:${account.id}`, {
    account,
    expiresAt: Date.now() + OWNED_ACCOUNT_CACHE_TTL_MS,
  });
}

function getCachedOwnedAccount(discordUserId, accountId) {
  pruneExpiredStates();
  const key = `${discordUserId}:${accountId}`;
  const entry = ownedAccountsCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    ownedAccountsCache.delete(key);
    return null;
  }
  return entry.account;
}

function removeCachedOwnedAccount(discordUserId, accountId) {
  ownedAccountsCache.delete(`${discordUserId}:${accountId}`);
}

function formatPlatformName(platform) {
  return platform === "youtube" ? "YouTube" : "TikTok";
}

export function buildRegistrationPanelPayload() {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(PANEL_TITLE)
    .setDescription(
      "Daftarkan akun streaming kamu untuk menerima notifikasi otomatis ke server saat memulai live streaming."
    )
    .addFields(
      {
        name: "Platforms",
        value: "YouTube & TikTok",
        inline: true,
      },
      {
        name: "Guide",
        value: "Select Platform → Register",
        inline: true,
      },
      {
        name: "Ownership",
        value: "Dikelola Pemilik Akun",
        inline: true,
      }
    );

  const selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("reg_select_platform")
      .setPlaceholder("Select Platform")
      .addOptions(
        {
          label: "YouTube",
          value: "youtube",
        },
        {
          label: "TikTok",
          value: "tiktok",
        }
      )
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("reg_open_modal")
      .setLabel("Register Account")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("reg_my_accounts")
      .setLabel("My Accounts")
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    embeds: [embed],
    components: [selectRow, buttonRow],
  };
}

export async function ensureRegistrationPanel(client) {
  const channelId = config.channels.registerChannelId;
  if (!channelId) {
    console.warn(
      "[REGISTRATION] REGISTER_CHANNEL_ID belum dikonfigurasi, melewati inisialisasi panel."
    );
    return null;
  }

  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    console.error(
      `[REGISTRATION] Channel registrasi (${channelId}) tidak ditemukan atau bukan text channel.`
    );
    return null;
  }

  const payload = buildRegistrationPanelPayload();
  const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);

  const existingPanel = messages?.find(
    (msg) =>
      msg.author?.id === client.user.id &&
      LEGACY_PANEL_TITLES.has(msg.embeds?.[0]?.title)
  );

  if (existingPanel) {
    const updatedPanel = await existingPanel.edit(payload);
    console.log(
      `[REGISTRATION] Panel registrasi diperbarui di #${channel.name} (id: ${updatedPanel.id}).`
    );
    return updatedPanel;
  }

  const created = await channel.send(payload);
  console.log(
    `[REGISTRATION] Panel registrasi baru dibuat di #${channel.name} (id: ${created.id}).`
  );
  return created;
}

export async function getOrCreateFamilyMember(discordUser) {
  const discordUserId = discordUser.id;
  const discordUsername = discordUser.tag || discordUser.username;

  const { data: existing, error: fetchError } = await supabase
    .from("family_members")
    .select("*")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  if (fetchError) {
    throw new Error(`Gagal memeriksa data anggota: ${fetchError.message}`);
  }

  if (existing) {
    if (existing.discord_username !== discordUsername) {
      await supabase
        .from("family_members")
        .update({ discord_username: discordUsername })
        .eq("id", existing.id);
    }
    return existing;
  }

  const { data: created, error: insertError } = await supabase
    .from("family_members")
    .insert({
      discord_user_id: discordUserId,
      discord_username: discordUsername,
    })
    .select("*")
    .single();

  if (insertError) {
    throw new Error(`Gagal menyimpan data anggota: ${insertError.message}`);
  }

  return created;
}

async function findExistingStreamAccount({
  platform,
  platformUserId,
  username,
  excludeAccountId = null,
}) {
  let query = supabase
    .from("stream_accounts")
    .select("id, member_id, platform, username, platform_user_id")
    .eq("platform", platform);

  if (excludeAccountId) {
    query = query.neq("id", excludeAccountId);
  }

  const { data: accounts, error } = await query;
  if (error) {
    throw new Error(`Gagal memeriksa duplikasi akun: ${error.message}`);
  }

  const normalizedUsername = String(username || "").trim().toLowerCase();
  const normalizedPlatformId = String(platformUserId || "").trim().toLowerCase();

  return (
    (accounts || []).find((acc) => {
      const samePlatformId =
        normalizedPlatformId &&
        String(acc.platform_user_id || "").trim().toLowerCase() ===
          normalizedPlatformId;
      const sameUsername =
        normalizedUsername &&
        String(acc.username || "").trim().toLowerCase() === normalizedUsername;
      return samePlatformId || sameUsername;
    }) || null
  );
}

async function resolvePlatformAccount(platform, rawInput) {
  if (platform === "youtube") {
    return resolveYouTubeChannel(rawInput);
  }
  if (platform === "tiktok") {
    return resolveTikTokAccount(rawInput);
  }
  throw new Error("Platform tidak didukung.");
}

export async function handlePlatformSelect(interaction) {
  const platform = interaction.values?.[0];
  if (!["youtube", "tiktok"].includes(platform)) {
    await interaction.reply({
      content: "Pilihan platform tidak valid.",
      flags: MessageFlags.Ephemeral,
    });
    await registerActiveEphemeral(interaction.user.id, interaction, 5000);
    return;
  }

  setSelectedPlatform(interaction.user.id, platform);
  await interaction.deferUpdate();
}

export async function handleOpenRegisterModal(interaction) {
  const platform = getSelectedPlatform(interaction.user.id);

  if (!platform) {
    await interaction.reply({
      content:
        "Pilih platform (**YouTube** atau **TikTok**) terlebih dahulu pada menu **Select Platform**.",
      flags: MessageFlags.Ephemeral,
    });
    await registerActiveEphemeral(interaction.user.id, interaction, 5000);
    return;
  }

  const label = formatPlatformName(platform);

  const modal = new ModalBuilder()
    .setCustomId(`reg_modal:${platform}`)
    .setTitle(`Register ${label} Account`);

  const placeholder =
    platform === "youtube"
      ? "@username atau https://www.youtube.com/@username"
      : "@username atau https://www.tiktok.com/@username";

  const input = new TextInputBuilder()
    .setCustomId("account_input")
    .setLabel(`Username atau URL ${label}`)
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(placeholder)
    .setRequired(true)
    .setMaxLength(200);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleRegisterModalSubmit(interaction, platform) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await registerActiveEphemeral(interaction.user.id, interaction);

  if (!["youtube", "tiktok"].includes(platform)) {
    await interaction.editReply({
      content: "Platform tidak valid. Silakan ulangi dari panel registrasi.",
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 6000);
    return;
  }

  const rawInput = interaction.fields.getTextInputValue("account_input");
  const resolved = await resolvePlatformAccount(platform, rawInput);

  const duplicate = await findExistingStreamAccount({
    platform: resolved.platform,
    platformUserId: resolved.platformUserId,
    username: resolved.username,
  });

  if (duplicate) {
    await interaction.editReply({
      content: `Akun ${formatPlatformName(platform)} \`${resolved.username}\` sudah terdaftar.`,
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 6000);
    return;
  }

  pendingRegistrations.set(interaction.user.id, {
    discordUserId: interaction.user.id,
    ...resolved,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
  });

  const confirmEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Confirm Stream Account")
    .setDescription(
      "Pastikan detail akun streaming berikut sudah sesuai sebelum disimpan."
    )
    .addFields(
      {
        name: "Platform",
        value: formatPlatformName(resolved.platform),
        inline: true,
      },
      {
        name: "Account",
        value: `[${resolved.username}](${resolved.profileUrl})`,
        inline: true,
      },
      {
        name: "Monitoring",
        value: "Active",
        inline: true,
      }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("reg_confirm_yes")
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("reg_confirm_no")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    embeds: [confirmEmbed],
    components: [row],
  });
}

export async function handleConfirmRegistration(interaction, confirmed) {
  await interaction.deferUpdate();

  if (!confirmed) {
    clearUserRegistrationState(interaction.user.id);
    await interaction.editReply({
      content: "Registrasi akun dibatalkan.",
      embeds: [],
      components: [],
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 4000);
    return;
  }

  pruneExpiredStates();
  const pending = pendingRegistrations.get(interaction.user.id);

  if (
    !pending ||
    pending.discordUserId !== interaction.user.id ||
    Date.now() > pending.expiresAt
  ) {
    clearUserRegistrationState(interaction.user.id);
    await interaction.editReply({
      content:
        "Sesi konfirmasi telah kedaluwarsa. Silakan ulangi dari panel registrasi.",
      embeds: [],
      components: [],
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 5000);
    return;
  }

  const memberRecord = await getOrCreateFamilyMember(interaction.user);

  const duplicate = await findExistingStreamAccount({
    platform: pending.platform,
    platformUserId: pending.platformUserId,
    username: pending.username,
  });

  if (duplicate) {
    clearUserRegistrationState(interaction.user.id);
    await interaction.editReply({
      content: `Akun ${formatPlatformName(pending.platform)} \`${pending.username}\` sudah terdaftar.`,
      embeds: [],
      components: [],
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 6000);
    return;
  }

  const { data: insertedAccount, error: insertError } = await supabase
    .from("stream_accounts")
    .insert({
      member_id: memberRecord.id,
      platform: pending.platform,
      username: pending.username,
      profile_url: pending.profileUrl,
      platform_user_id: pending.platformUserId,
      is_active: true,
      is_live: false,
    })
    .select("*")
    .single();

  clearUserRegistrationState(interaction.user.id);

  if (insertError) {
    throw new Error(`Gagal menyimpan akun ke database: ${insertError.message}`);
  }

  if (insertedAccount) {
    cacheOwnedAccount(interaction.user.id, insertedAccount);
  }

  const successEmbed = new EmbedBuilder()
    .setColor(SUCCESS_COLOR)
    .setTitle("Account Registered")
    .setDescription(
      "Akun streaming berhasil ditambahkan ke sistem monitoring otomatis."
    )
    .addFields(
      {
        name: "Platform",
        value: formatPlatformName(pending.platform),
        inline: true,
      },
      {
        name: "Account",
        value: `[${pending.username}](${pending.profileUrl})`,
        inline: true,
      },
      {
        name: "Status",
        value: "Active",
        inline: true,
      }
    );

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("reg_my_accounts_inline")
      .setLabel("My Accounts")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("reg_close_ephemeral")
      .setLabel("Close")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: null,
    embeds: [successEmbed],
    components: [actionRow],
  });

  scheduleEphemeralAutoDelete(interaction.user.id, interaction, 15000);
}

export async function buildMyAccountsPayload(
  discordUser,
  { selectedAccountId = null, notice = null } = {}
) {
  const { data: member } = await supabase
    .from("family_members")
    .select("id, discord_user_id, discord_username")
    .eq("discord_user_id", discordUser.id)
    .maybeSingle();

  const emptyEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("My Accounts")
    .setDescription(
      notice
        ? `${notice}\n\nBelum ada akun streaming yang terdaftar. Pilih platform pada panel lalu tekan **Register Account**.`
        : "Belum ada akun streaming yang terdaftar. Pilih platform pada panel lalu tekan **Register Account**."
    );

  const closeOnlyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("reg_close_ephemeral")
      .setLabel("Close")
      .setStyle(ButtonStyle.Secondary)
  );

  if (!member) {
    return {
      isEmpty: true,
      payload: {
        content: null,
        embeds: [emptyEmbed],
        components: [closeOnlyRow],
      },
    };
  }

  const { data: accounts, error } = await supabase
    .from("stream_accounts")
    .select("*")
    .eq("member_id", member.id)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Gagal memuat daftar akun: ${error.message}`);
  }

  if (!accounts || accounts.length === 0) {
    return {
      isEmpty: true,
      payload: {
        content: null,
        embeds: [emptyEmbed],
        components: [closeOnlyRow],
      },
    };
  }

  for (const acc of accounts) {
    cacheOwnedAccount(discordUser.id, acc);
  }

  const activeAccount =
    accounts.find((a) => a.id === selectedAccountId) || accounts[0];

  const baseDesc =
    "Kelola akun streaming yang terdaftar pada profil Discord kamu.";
  const description = notice ? `*${notice}*\n\n${baseDesc}` : baseDesc;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("My Accounts")
    .setDescription(description);

  for (const [idx, acc] of accounts.entries()) {
    const platformLabel = formatPlatformName(acc.platform);
    const liveBadge = acc.is_live ? "LIVE" : "Offline";
    const isSelected = acc.id === activeAccount.id;
    const prefix = isSelected && accounts.length > 1 ? "▸ " : "";

    embed.addFields({
      name: `${prefix}${idx + 1}. ${platformLabel}`,
      value: `[${acc.username}](${acc.profile_url})\n\`Active · ${liveBadge}\``,
      inline: true,
    });
  }

  const components = [];

  if (accounts.length > 1) {
    const options = accounts.slice(0, 25).map((acc, idx) => ({
      label: `${idx + 1}. ${formatPlatformName(acc.platform)} — ${acc.username}`,
      value: acc.id,
      default: acc.id === activeAccount.id,
    }));

    components.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("acc_manage_select")
          .setPlaceholder("Select Account")
          .addOptions(options)
      )
    );
  }

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`acc_edit_btn:${activeAccount.id}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`acc_delete_btn:${activeAccount.id}`)
      .setLabel("Remove")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("reg_close_ephemeral")
      .setLabel("Close")
      .setStyle(ButtonStyle.Secondary)
  );

  components.push(actionRow);

  return {
    isEmpty: false,
    payload: {
      content: null,
      embeds: [embed],
      components,
    },
  };
}

export async function handleMyAccounts(
  interaction,
  { inlineUpdate = false } = {}
) {
  if (inlineUpdate) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await registerActiveEphemeral(interaction.user.id, interaction);
  }

  const { isEmpty, payload } = await buildMyAccountsPayload(interaction.user);
  await interaction.editReply(payload);

  if (isEmpty) {
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 8000);
  } else {
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 60000);
  }
}

export async function handleManageAccountSelect(interaction) {
  await interaction.deferUpdate();
  const accountId = interaction.values?.[0];
  const { payload } = await buildMyAccountsPayload(interaction.user, {
    selectedAccountId: accountId,
  });
  await interaction.editReply(payload);
  scheduleEphemeralAutoDelete(interaction.user.id, interaction, 60000);
}

export async function getVerifiedOwnedAccount(discordUserId, accountId) {
  if (!discordUserId || !accountId) {
    return { member: null, account: null };
  }

  const { data: member } = await supabase
    .from("family_members")
    .select("id, discord_user_id")
    .eq("discord_user_id", discordUserId)
    .maybeSingle();

  if (!member) {
    return { member: null, account: null };
  }

  const { data: account } = await supabase
    .from("stream_accounts")
    .select("*")
    .eq("id", accountId)
    .eq("member_id", member.id)
    .maybeSingle();

  if (account) {
    cacheOwnedAccount(discordUserId, account);
  }

  return { member, account };
}

export async function handleEditAccountSelect(
  interaction,
  explicitAccountId = null
) {
  const accountId = explicitAccountId || interaction.values?.[0];
  if (!accountId) {
    await interaction.reply({
      content: "Akun yang dipilih tidak valid.",
      flags: MessageFlags.Ephemeral,
    });
    await registerActiveEphemeral(interaction.user.id, interaction, 5000);
    return;
  }

  let account = getCachedOwnedAccount(interaction.user.id, accountId);
  if (!account) {
    const verified = await getVerifiedOwnedAccount(
      interaction.user.id,
      accountId
    );
    account = verified.account;
  }

  if (!account) {
    await interaction.reply({
      content: "Akun tidak ditemukan atau kamu tidak memiliki akses ke akun ini.",
      flags: MessageFlags.Ephemeral,
    });
    await registerActiveEphemeral(interaction.user.id, interaction, 5000);
    return;
  }

  const label = formatPlatformName(account.platform);
  const modal = new ModalBuilder()
    .setCustomId(`acc_edit_modal:${account.id}`)
    .setTitle(`Edit ${label} Account`);

  const input = new TextInputBuilder()
    .setCustomId("account_input")
    .setLabel(`Username atau URL ${label}`)
    .setStyle(TextInputStyle.Short)
    .setValue(account.profile_url || account.username)
    .setRequired(true)
    .setMaxLength(200);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

export async function handleEditAccountModalSubmit(interaction, accountId) {
  const canUpdateInPlace =
    typeof interaction.isFromMessage === "function" &&
    interaction.isFromMessage();

  if (canUpdateInPlace) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await registerActiveEphemeral(interaction.user.id, interaction);
  }

  const { member, account } = await getVerifiedOwnedAccount(
    interaction.user.id,
    accountId
  );

  if (!member || !account) {
    await interaction.editReply({
      content: "Akses ditolak: akun ini bukan milik kamu atau sudah dihapus.",
      embeds: [],
      components: [],
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 5000);
    return;
  }

  const rawInput = interaction.fields.getTextInputValue("account_input");
  const resolved = await resolvePlatformAccount(account.platform, rawInput);

  const duplicate = await findExistingStreamAccount({
    platform: account.platform,
    platformUserId: resolved.platformUserId,
    username: resolved.username,
    excludeAccountId: account.id,
  });

  if (duplicate) {
    if (canUpdateInPlace) {
      const { payload } = await buildMyAccountsPayload(interaction.user, {
        selectedAccountId: account.id,
        notice: `Akun ${formatPlatformName(account.platform)} ${resolved.username} sudah terdaftar.`,
      });
      await interaction.editReply(payload);
    } else {
      await interaction.editReply({
        content: `Akun ${formatPlatformName(account.platform)} \`${resolved.username}\` sudah terdaftar pada akun lain.`,
      });
    }
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 15000);
    return;
  }

  const { data: updated, error } = await supabase
    .from("stream_accounts")
    .update({
      username: resolved.username,
      profile_url: resolved.profileUrl,
      platform_user_id: resolved.platformUserId,
      is_live: false,
      last_checked_at: null,
    })
    .eq("id", account.id)
    .eq("member_id", member.id)
    .select("*")
    .single();

  if (error || !updated) {
    throw new Error(
      `Gagal memperbarui akun: ${error?.message || "Unauthorized"}`
    );
  }

  cacheOwnedAccount(interaction.user.id, updated);

  const { payload } = await buildMyAccountsPayload(interaction.user, {
    selectedAccountId: updated.id,
    notice: `Akun ${formatPlatformName(updated.platform)} diperbarui menjadi ${updated.username}.`,
  });
  await interaction.editReply(payload);
  scheduleEphemeralAutoDelete(interaction.user.id, interaction, 30000);
}

export async function handleDeleteAccountSelect(
  interaction,
  explicitAccountId = null
) {
  await interaction.deferUpdate();

  const accountId = explicitAccountId || interaction.values?.[0];
  const { account } = await getVerifiedOwnedAccount(
    interaction.user.id,
    accountId
  );

  if (!account) {
    await interaction.editReply({
      content: "Akun tidak ditemukan atau bukan milik kamu.",
      embeds: [],
      components: [],
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 5000);
    return;
  }

  const deleteEmbed = new EmbedBuilder()
    .setColor(DANGER_COLOR)
    .setTitle("Remove Account")
    .setDescription(
      "Apakah kamu yakin ingin menghapus akun berikut dari sistem monitoring?"
    )
    .addFields(
      {
        name: "Platform",
        value: formatPlatformName(account.platform),
        inline: true,
      },
      {
        name: "Account",
        value: `[${account.username}](${account.profile_url})`,
        inline: true,
      }
    );

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`acc_delete_confirm:${account.id}`)
      .setLabel("Remove")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("acc_delete_cancel")
      .setLabel("Back")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({
    content: null,
    embeds: [deleteEmbed],
    components: [confirmRow],
  });
  scheduleEphemeralAutoDelete(interaction.user.id, interaction, 20000);
}

export async function handleDeleteAccountConfirm(interaction, accountId) {
  await interaction.deferUpdate();

  if (!accountId) {
    const { payload } = await buildMyAccountsPayload(interaction.user);
    await interaction.editReply(payload);
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 30000);
    return;
  }

  const { member, account } = await getVerifiedOwnedAccount(
    interaction.user.id,
    accountId
  );

  if (!member || !account) {
    await interaction.editReply({
      content: "Penghapusan ditolak: akun tidak ditemukan atau bukan milik kamu.",
      embeds: [],
      components: [],
    });
    scheduleEphemeralAutoDelete(interaction.user.id, interaction, 5000);
    return;
  }

  await supabase.from("notification_logs").delete().eq("account_id", account.id);
  await supabase.from("live_sessions").delete().eq("account_id", account.id);

  const { data: deleted, error } = await supabase
    .from("stream_accounts")
    .delete()
    .eq("id", accountId)
    .eq("member_id", member.id)
    .select("id, platform, username");

  if (error || !deleted || deleted.length === 0) {
    throw new Error(
      `Gagal menghapus akun: ${error?.message || "Akun tidak ditemukan"}`
    );
  }

  removeCachedOwnedAccount(interaction.user.id, accountId);

  const { isEmpty, payload } = await buildMyAccountsPayload(interaction.user, {
    notice: `Akun ${formatPlatformName(account.platform)} ${account.username} telah dihapus.`,
  });

  await interaction.editReply(payload);
  scheduleEphemeralAutoDelete(
    interaction.user.id,
    interaction,
    isEmpty ? 6000 : 25000
  );
}
