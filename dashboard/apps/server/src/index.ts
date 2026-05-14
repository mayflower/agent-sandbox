import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "./app.js";
import { FakeInventoryProvider } from "./providers/fake-provider.js";
import { createKubernetesInventoryProvider } from "./providers/kubernetes-provider.js";
import { HistoryStore } from "./history/history-store.js";
import { TimelineStore } from "./timeline/timeline-store.js";
import { startPollLoop } from "./history/poll-loop.js";
import { createCostConfigLoader } from "./cost/config.js";
import { loadTenancyConfig } from "./identity/middleware.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticDir = path.resolve(moduleDir, "../../web/dist");

function createProvider() {
  if (process.env.DASHBOARD_FAKE_PROVIDER === "true") {
    return new FakeInventoryProvider();
  }

  return createKubernetesInventoryProvider(process.env);
}

async function main() {
  const provider = createProvider();
  const dataDir = process.env.DASHBOARD_DATA_DIR ?? path.resolve(moduleDir, "../../.dashboard-history");
  const historyStore = new HistoryStore({ dataDir });
  const timelineStore = new TimelineStore();

  const costConfigPath = process.env.DASHBOARD_COST_CONFIG ?? path.resolve(moduleDir, "../../../config/cost.yaml");
  const costLoader = createCostConfigLoader(costConfigPath);
  costLoader.start();

  const tenancyConfig = loadTenancyConfig(process.env);

  const app = buildApp({
    provider,
    staticDir: defaultStaticDir,
    historyStore,
    timelineStore,
    getCostRates: () => costLoader.current(),
    tenancyConfig,
  });

  const pollIntervalMs = Number(process.env.DASHBOARD_POLL_MS ?? "15000");
  startPollLoop({
    provider,
    historyStore,
    timelineStore,
    getCostRates: () => costLoader.current(),
    intervalMs: pollIntervalMs,
  });

  const port = Number(process.env.PORT ?? "8080");
  const host = process.env.HOST ?? "0.0.0.0";

  await app.listen({ port, host });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
