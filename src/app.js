const { loadConfig } = require('./config');
const { createCommands } = require('./commands/registry');
const { createClient } = require('./discord/client');

async function start() {
  const config = loadConfig();
  const commands = createCommands();
  const client = createClient(config, commands);

  await client.login(config.discord.token);
}

module.exports = { start };
