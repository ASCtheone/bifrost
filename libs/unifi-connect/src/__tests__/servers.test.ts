import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { server, resetPeers } from "./helpers/mock-server.js";
import { MOCK_SERVER } from "./helpers/fixtures.js";
import { UniFiClient } from "../client.js";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  resetPeers();
});
afterAll(() => server.close());

function createClient() {
  return new UniFiClient({
    host: "192.168.1.1",
    port: 443,
    username: "admin",
    password: "password",
  });
}

describe("ServerEndpoints", () => {
  describe("list", () => {
    it("should return all WireGuard servers", async () => {
      const client = createClient();
      const servers = await client.servers.list();

      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        _id: MOCK_SERVER._id,
        name: MOCK_SERVER.name,
        server_port: 51820,
        enabled: true,
      });
    });

    it("should include all server fields", async () => {
      const client = createClient();
      const servers = await client.servers.list();
      const s = servers[0]!;

      expect(s.interface).toBe("wg0");
      expect(s.server_address).toBe("10.0.0.1/24");
      expect(s.dns).toEqual(["1.1.1.1", "8.8.8.8"]);
      expect(s.mtu).toBe(1420);
      expect(s.host_address).toBe("203.0.113.1");
      expect(s.server_public_key).toBeDefined();
      expect(s.server_private_key).toBeDefined();
    });
  });

  describe("get", () => {
    it("should return a server by id", async () => {
      const client = createClient();
      const s = await client.servers.get(MOCK_SERVER._id);

      expect(s._id).toBe(MOCK_SERVER._id);
      expect(s.name).toBe(MOCK_SERVER.name);
    });

    it("should throw on non-existent server", async () => {
      const client = createClient();
      await expect(client.servers.get("nonexistent")).rejects.toThrow(
        "not found",
      );
    });
  });
});
