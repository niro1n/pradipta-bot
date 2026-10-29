const dotenv = require('dotenv');

dotenv.config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} wajib diisi.`);
  }
  return value;
}

function loadConfig() {
  return {
    discord: {
      token: required('DISCORD_TOKEN'),
      clientId: required('CLIENT_ID'),
      guildId: required('GUILD_ID')
    }
  };
}

module.exports = { loadConfig };
