import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

if (!config.dataFile) {
  console.warn('DATA_FILE is not set, so everything is kept in memory and lost on restart.');
}

const store = await Store.open(config.dataFile);
const { app } = createApp(config, store);

const server = app.listen(config.port, () => {
  console.log(`Team Me connector listening on port ${config.port}`);
  console.log(`Connector URL: ${new URL('/mcp', config.publicBaseUrl).href}`);
  if (!config.commandCenterApiKey) console.log('Command Center API is off (COMMAND_CENTER_API_KEY not set).');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
