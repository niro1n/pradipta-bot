import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function loadEvents(client) {
  const eventsDir = path.join(__dirname, "..", "events");
  const files = await readdir(eventsDir);
  const eventFiles = files.filter((file) => file.endsWith(".js")).sort();

  for (const file of eventFiles) {
    const filePath = path.join(eventsDir, file);
    const eventModule = await import(pathToFileURL(filePath).href);
    const event = eventModule.default ?? eventModule;

    if (!event?.name || typeof event.execute !== "function") {
      console.warn(`[EVENT] Melewati ${file}: format event tidak valid.`);
      continue;
    }

    client.removeAllListeners(event.name);

    const listener = async (...args) => {
      try {
        await event.execute(...args);
      } catch (error) {
        console.error(
          `[EVENT ERROR] Terjadi kesalahan pada event "${event.name}":`,
          error
        );
      }
    };

    if (event.once) {
      client.once(event.name, listener);
    } else {
      client.on(event.name, listener);
    }

    console.log(`[EVENT] Terdaftar: ${event.name} (${file})`);
  }
}
