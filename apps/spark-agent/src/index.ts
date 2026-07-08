import "dotenv/config";

// UniFi controllers use self-signed certificates
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
import { resolve } from "node:path";
import {
  loadBifrostConfig,
  loadNodeKey,
  saveNodeKey,
  registerAgent,
  awaitAdoption,
} from "./adoption.js";
import { loadOperationalConfig } from "./config.js";
import { Heartbeat } from "./heartbeat.js";
import { ConfigListener } from "./config-listener.js";
import { ConfigApplier, DriftDetector } from "./config-applier.js";
import { UniFiBridge } from "./unifi-bridge.js";
import { startApiServer } from "./api/server.js";

async function main(): Promise<void> {
  // ── Step 1: Load bifrost config file ──────────────────────────
  const configPath = resolve(
    process.env["BIFROST_CONFIG_FILE"] ?? "./bifrost-config.json",
  );

  console.log(`[spark] Loading config from ${configPath}`);
  const bifrostConfig = loadBifrostConfig(configPath);

  console.log(`[spark] Node: ${bifrostConfig.nodeName} (${bifrostConfig.nodeId})`);
  console.log(`[spark] API: ${bifrostConfig.apiUrl}`);

  // ── Step 2: Check for existing key or run adoption flow ───────
  let nodeKey = loadNodeKey(configPath);

  if (!nodeKey) {
    console.log("[spark] No node key found — starting adoption flow");

    // Register with the API using adoption code
    console.log("[spark] Registering with adoption code...");
    await registerAgent(bifrostConfig.apiUrl, bifrostConfig.adoptionCode);
    console.log("[spark] Registered! Status: available");

    // Poll until admin adopts
    nodeKey = await awaitAdoption(bifrostConfig.apiUrl, bifrostConfig.adoptionCode, bifrostConfig.nodeId);
    saveNodeKey(configPath, nodeKey);
  } else {
    console.log("[spark] Node key found — skipping adoption");
  }

  // ── Step 3: Load operational config ───────────────────────────
  const config = loadOperationalConfig(
    bifrostConfig.nodeId,
    bifrostConfig.nodeName,
    bifrostConfig.apiUrl,
    bifrostConfig.wsUrl,
    nodeKey,
  );

  if (config.tableName) {
    process.env["TABLE_NAME"] = config.tableName;
  }

  // ── Step 3b: Fetch controller config from API ─────────────────
  let controllerUrl = config.controllerUrl;
  let controllerApiKey = config.controllerApiKey;

  try {
    console.log("[spark] Fetching node config from API...");
    const res = await fetch(`${config.apiUrl}/nodes/${config.nodeId}/self`, {
      headers: { "X-Node-Key": nodeKey },
    });
    if (res.ok) {
      const data = await res.json() as { node?: { controllerUrl?: string; controllerApiKey?: string } };
      if (data.node?.controllerUrl) controllerUrl = data.node.controllerUrl;
      if (data.node?.controllerApiKey) controllerApiKey = data.node.controllerApiKey;
      console.log(`[spark] Controller config from API: ${controllerUrl}`);
    }
  } catch (err) {
    console.warn("[spark] Failed to fetch node config from API, using env vars:", err);
  }

  console.log(`[spark] Controller: ${controllerUrl}`);

  // ── Step 4: Start subsystems ──────────────────────────────────

  // Create UniFi bridge — strip protocol from URL for the host field
  const controllerHost = controllerUrl.replace(/^https?:\/\//, "");
  const bridge = new UniFiBridge({
    connection: {
      host: controllerHost,
      apiKey: controllerApiKey || undefined,
    },
  });
  console.log("[spark] UniFi bridge created");

  // Start heartbeat (uses API with node key, syncs VPN snapshot)
  const heartbeat = new Heartbeat(
    config.nodeId,
    config.heartbeatIntervalMs,
    config.apiUrl,
    config.nodeKey,
    bridge,
  );
  await heartbeat.register();
  heartbeat.start();
  console.log(`[spark] Heartbeat started (every ${config.heartbeatIntervalMs}ms)`);

  // Config applier
  const applier = new ConfigApplier({
    nodeId: config.nodeId,
    tableName: config.tableName,
    bridge,
    maxRetries: 10,
    baseRetryDelayMs: 1000,
    maxRetryDelayMs: 300000,
  });

  // Config listener (WebSocket + poll)
  const configListener = new ConfigListener(
    config.nodeId,
    config.tableName,
    config.wsUrl,
  );
  await configListener.init();
  configListener.setSyncCallback(async (desiredConfig, configVersion) => {
    await applier.apply(desiredConfig, configVersion);
  });
  configListener.start();
  console.log("[spark] Config listener started");

  // Drift detector
  const driftDetector = new DriftDetector(applier, 300000);
  driftDetector.start();

  // API server
  startApiServer(config.port, config.nodeId, bridge);

  // ── Graceful shutdown ─────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`[spark] Received ${signal}, shutting down...`);
    driftDetector.stop();
    configListener.stop();
    await heartbeat.shutdown();
    await bridge.shutdown();
    console.log("[spark] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("[spark] Spark agent ready");
}

main().catch((error) => {
  console.error("[spark] Fatal error:", error);
  process.exit(1);
});
