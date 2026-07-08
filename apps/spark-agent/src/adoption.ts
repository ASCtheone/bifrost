import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ── Config file (downloaded from dashboard) ─────────────────────

export interface BifrostConfig {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly adoptionCode: string;
  readonly apiUrl: string;
  readonly wsUrl: string;
}

export function loadBifrostConfig(configPath: string): BifrostConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as BifrostConfig;

  if (!config.nodeId || !config.adoptionCode || !config.apiUrl) {
    throw new Error("Config file missing required fields: nodeId, adoptionCode, apiUrl");
  }

  return config;
}

// ── Node key persistence ────────────────────────────────────────

const KEY_FILE = ".bifrost-key";

export function getKeyPath(configPath: string): string {
  return join(dirname(configPath), KEY_FILE);
}

export function loadNodeKey(configPath: string): string | null {
  const keyPath = getKeyPath(configPath);
  if (!existsSync(keyPath)) return null;
  return readFileSync(keyPath, "utf-8").trim();
}

export function saveNodeKey(configPath: string, key: string): void {
  const keyPath = getKeyPath(configPath);
  writeFileSync(keyPath, key, { mode: 0o600 });
  console.log(`[adoption] Node key saved to ${keyPath}`);
}

// ── API calls for adoption flow ─────────────────────────────────

export async function registerAgent(apiUrl: string, adoptionCode: string): Promise<{ nodeId: string }> {
  const res = await fetch(`${apiUrl}/agent/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ adoptionCode }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(`Register failed: ${err.error ?? res.statusText}`);
  }

  return res.json() as Promise<{ nodeId: string }>;
}

export async function awaitAdoption(
  apiUrl: string,
  adoptionCode: string,
  nodeId: string,
  pollIntervalMs = 5000,
): Promise<string> {
  console.log("[adoption] Waiting for admin to adopt this node...");

  while (true) {
    const res = await fetch(
      `${apiUrl}/agent/await-adoption?code=${encodeURIComponent(adoptionCode)}&nodeId=${encodeURIComponent(nodeId)}`,
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(`Await adoption failed: ${err.error ?? res.statusText}`);
    }

    const data = await res.json() as { status: string; nodeKey?: string | null };

    if (data.status === "adopted" && data.nodeKey) {
      console.log("[adoption] Node adopted! Key received.");
      return data.nodeKey;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
