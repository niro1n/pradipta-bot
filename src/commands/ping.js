const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Cek latensi bot'),
  async execute(interaction) {
    await interaction.reply({
      content: `Latensi bot: \`${interaction.client.ws.ping}ms\``
    });
  }
};
