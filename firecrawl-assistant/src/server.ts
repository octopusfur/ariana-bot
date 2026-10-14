import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const cfg = loadConfig();
const app = createApp(cfg);

// Vercel runs the exported app as a function; locally / in Docker we listen on a port.
if (!process.env.VERCEL) {
  app.listen(cfg.port, () => console.log(`firecrawl-assistant listening on :${cfg.port}${cfg.firecrawlApiUrl ? ` (self-hosted Firecrawl at ${cfg.firecrawlApiUrl})` : ""}`));
}

export default app;
