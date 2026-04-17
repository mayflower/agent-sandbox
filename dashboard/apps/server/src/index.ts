import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildApp } from "./app.js";
import { FakeInventoryProvider } from "./providers/fake-provider.js";
import { createKubernetesInventoryProvider } from "./providers/kubernetes-provider.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticDir = path.resolve(moduleDir, "../../web/dist");

function createProvider() {
  if (process.env.DASHBOARD_FAKE_PROVIDER === "true") {
    return new FakeInventoryProvider();
  }

  return createKubernetesInventoryProvider(process.env);
}

async function main() {
  const app = buildApp({
    provider: createProvider(),
    staticDir: defaultStaticDir,
  });
  const port = Number(process.env.PORT ?? "8080");
  const host = process.env.HOST ?? "0.0.0.0";

  await app.listen({ port, host });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
