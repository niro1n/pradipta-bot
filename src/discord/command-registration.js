const { REST, Routes } = require('discord.js');

async function registerCommands(config, commands) {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = [...commands.values()].map((command) => command.data.toJSON());

  console.log('[commands] Mendaftarkan slash command...');
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body }
  );
  console.log(`[commands] ${body.length} slash command berhasil didaftarkan.`);
}

module.exports = { registerCommands };
