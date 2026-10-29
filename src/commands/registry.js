const ping = require('./ping');

function createCommands() {
  const commands = [ping];

  return new Map(commands.map((command) => [command.data.name, command]));
}

module.exports = { createCommands };
