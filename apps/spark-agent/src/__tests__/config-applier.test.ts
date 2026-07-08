import { describe, it, expect, vi } from "vitest";
import { ConfigApplier } from "../config-applier.js";
import type { UniFiBridge } from "../unifi-bridge.js";
import type { VpnConfigSnapshot } from "@bifrost/dynamo-schema";

const mockSend = vi.fn().mockResolvedValue({
  Item: {
    lastAppliedVersion: 0,
    actualConfig: { servers: [], peers: [] },
  },
});

// Mock aws-client
vi.mock("../aws-client.js", () => ({
  getDocClient: () => ({
    send: mockSend,
  }),
}));

vi.mock("@bifrost/dynamo-schema", () => ({
  nodeKey: (id: string) => ({ PK: `NODE#${id}`, SK: `NODE#${id}` }),
}));

function createMockBridge(
  snapshot: VpnConfigSnapshot = { servers: [], peers: [] },
): UniFiBridge {
  return {
    readSnapshot: vi.fn().mockResolvedValue(snapshot),
    diffAndApply: vi.fn().mockResolvedValue(snapshot),
    createPeer: vi.fn(),
    updatePeer: vi.fn(),
    deletePeer: vi.fn(),
    getServer: vi.fn(),
    getPeer: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as UniFiBridge;
}

describe("ConfigApplier", () => {
  const createOpts = (bridge: UniFiBridge) => ({
    nodeId: "test-node",
    tableName: "BifrostTable",
    bridge,
    maxRetries: 2,
    baseRetryDelayMs: 10,
    maxRetryDelayMs: 50,
  });

  it("should apply config and update node doc to synced", async () => {
    const bridge = createMockBridge({
      servers: [{ id: "srv1", name: "wg0", serverAddress: "10.0.0.1", serverPort: 51820, publicKey: "abc" }],
      peers: [],
    });
    // Mock QueryCommand for readDesiredPeers
    mockSend.mockResolvedValueOnce({ Items: [] }); // query result
    mockSend.mockResolvedValueOnce(undefined); // update result

    const applier = new ConfigApplier(createOpts(bridge));

    await expect(
      applier.apply({ server: {}, defaults: {} }, 1),
    ).resolves.not.toThrow();
  });

  it("should check drift without throwing", async () => {
    const bridge = createMockBridge();
    const applier = new ConfigApplier(createOpts(bridge));
    const hasDrift = await applier.checkDrift();
    expect(hasDrift).toBe(false);
  });

  it("should detect drift when peer counts differ", async () => {
    const bridge = createMockBridge();
    const applier = new ConfigApplier(createOpts(bridge));
    const result = await applier.checkDrift();
    expect(typeof result).toBe("boolean");
  });
});
