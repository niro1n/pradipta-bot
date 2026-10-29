const { Client, GatewayIntentBits } = require('discord.js');
const { registerCommands } = require('./command-registration');

function createClient(config, commands) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    console.log(`[bot] Aktif sebagai ${client.user.tag}`);
    try {
      await registerCommands(config.discord, commands);
    } catch (error) {
      console.error('[commands] Gagal mendaftarkan slash command:', error.message);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(`[command:${interaction.commandName}]`, error);
      const reply = { content: 'Terjadi kesalahan saat menjalankan command.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.editReply(reply);
      else await interaction.reply(reply);
    }
  });

  return client;
}

module.exports = { createClient };
