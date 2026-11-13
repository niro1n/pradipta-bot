import { Events, MessageFlags } from "discord.js";
import config from "../config/config.js";
import {
  handleCloseEphemeral,
  handleConfirmRegistration,
  handleDeleteAccountConfirm,
  handleDeleteAccountSelect,
  handleEditAccountModalSubmit,
  handleEditAccountSelect,
  handleManageAccountSelect,
  handleMyAccounts,
  handleOpenRegisterModal,
  handlePlatformSelect,
  handleRegisterModalSubmit,
  registerActiveEphemeral,
  scheduleEphemeralAutoDelete,
} from "../services/registration.js";

function sanitizeUserErrorMessage(rawMessage) {
  if (!rawMessage || typeof rawMessage !== "string") {
    return "Terjadi kesalahan saat memproses permintaan kamu.";
  }

  let msg = rawMessage;
  const secrets = [
    config.discord?.token,
    config.supabase?.secretKey,
    config.supabase?.publishableKey,
    config.youtube?.apiKey,
  ].filter(Boolean);

  for (const secret of secrets) {
    msg = msg.replaceAll(secret, "[REDACTED]");
  }

  return msg;
}

export default {
  name: Events.InteractionCreate,
  once: false,
  async execute(interaction) {
    const startTime = Date.now();
    try {
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId === "reg_select_platform") {
          await handlePlatformSelect(interaction);
          return;
        }
        if (interaction.customId === "acc_manage_select") {
          await handleManageAccountSelect(interaction);
          return;
        }
        if (interaction.customId === "acc_edit_select") {
          await handleEditAccountSelect(interaction);
          return;
        }
        if (interaction.customId === "acc_delete_select") {
          await handleDeleteAccountSelect(interaction);
          return;
        }
      }

      if (interaction.isButton()) {
        if (interaction.customId === "reg_open_modal") {
          await handleOpenRegisterModal(interaction);
          return;
        }
        if (interaction.customId === "reg_my_accounts") {
          await handleMyAccounts(interaction, { inlineUpdate: false });
          return;
        }
        if (interaction.customId === "reg_my_accounts_inline") {
          await handleMyAccounts(interaction, { inlineUpdate: true });
          return;
        }
        if (interaction.customId === "reg_close_ephemeral") {
          await handleCloseEphemeral(interaction);
          return;
        }
        if (interaction.customId === "reg_confirm_yes") {
          await handleConfirmRegistration(interaction, true);
          return;
        }
        if (interaction.customId === "reg_confirm_no") {
          await handleConfirmRegistration(interaction, false);
          return;
        }
        if (interaction.customId.startsWith("acc_edit_btn:")) {
          const accountId = interaction.customId.slice("acc_edit_btn:".length);
          await handleEditAccountSelect(interaction, accountId);
          return;
        }
        if (interaction.customId.startsWith("acc_delete_btn:")) {
          const accountId = interaction.customId.slice(
            "acc_delete_btn:".length
          );
          await handleDeleteAccountSelect(interaction, accountId);
          return;
        }
        if (interaction.customId.startsWith("acc_delete_confirm:")) {
          const accountId = interaction.customId.slice(
            "acc_delete_confirm:".length
          );
          await handleDeleteAccountConfirm(interaction, accountId);
          return;
        }
        if (interaction.customId === "acc_delete_cancel") {
          await handleDeleteAccountConfirm(interaction, null);
          return;
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith("reg_modal:")) {
          const platform = interaction.customId.slice("reg_modal:".length);
          await handleRegisterModalSubmit(interaction, platform);
          return;
        }
        if (interaction.customId.startsWith("acc_edit_modal:")) {
          const accountId = interaction.customId.slice(
            "acc_edit_modal:".length
          );
          await handleEditAccountModalSubmit(interaction, accountId);
          return;
        }
      }

      if (
        (interaction.isMessageComponent?.() || interaction.isModalSubmit?.()) &&
        !interaction.replied &&
        !interaction.deferred
      ) {
        console.warn(
          `[INTERACTION] Unhandled customId: ${interaction.customId}`
        );
        await interaction.reply({
          content: "Interaksi ini sudah tidak berlaku.",
          flags: MessageFlags.Ephemeral,
        });
        await registerActiveEphemeral(interaction.user.id, interaction, 4000);
      }
    } catch (error) {
      const elapsed = Date.now() - startTime;
      const safeMessage = sanitizeUserErrorMessage(error?.message);
      console.error(
        `[INTERACTION ERROR] customId=${interaction.customId || "unknown"} user=${interaction.user?.id} (${elapsed}ms): ${safeMessage}`
      );

      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({
            content: safeMessage,
            flags: MessageFlags.Ephemeral,
          });
          await registerActiveEphemeral(interaction.user.id, interaction, 6000);
        } else if (interaction.customId === "reg_select_platform") {
          await interaction.followUp({
            content: safeMessage,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.editReply({
            content: safeMessage,
            embeds: [],
            components: [],
          });
          scheduleEphemeralAutoDelete(interaction.user.id, interaction, 6000);
        }
      } catch (replyErr) {
        console.error(
          `[INTERACTION REPLY ERROR] Gagal mengirim pesan error: ${sanitizeUserErrorMessage(replyErr?.message)}`
        );
      }
    }
  },
};
