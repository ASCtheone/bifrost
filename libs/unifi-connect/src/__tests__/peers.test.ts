import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { server, resetPeers } from "./helpers/mock-server.js";
import { MOCK_PEER, MOCK_SERVER } from "./helpers/fixtures.js";
import { UniFiClient } from "../client.js";
import { NotFoundError } from "../errors.js";

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

describe("PeerEndpoints", () => {
  describe("list", () => {
    it("should return all peers", async () => {
      const client = createClient();
      const peers = await client.peers.list();

      expect(peers).toHaveLength(1);
      expect(peers[0]).toMatchObject({
        _id: MOCK_PEER._id,
        name: "john-laptop",
        ip: "10.0.0.2",
      });
    });

    it("should filter by server_id", async () => {
      const client = createClient();
      const peers = await client.peers.list(MOCK_SERVER._id);
      expect(peers).toHaveLength(1);

      const none = await client.peers.list("nonexistent-server");
      expect(none).toHaveLength(0);
    });
  });

  describe("get", () => {
    it("should return a peer by id", async () => {
      const client = createClient();
      const peer = await client.peers.get(MOCK_PEER._id);

      expect(peer._id).toBe(MOCK_PEER._id);
      expect(peer.name).toBe("john-laptop");
      expect(peer.public_key).toBeDefined();
      expect(peer.private_key).toBeDefined();
    });

    it("should throw NotFoundError for non-existent peer", async () => {
      const client = createClient();
      await expect(client.peers.get("nonexistent")).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe("create", () => {
    it("should create a peer with controller-generated keys", async () => {
      const client = createClient();
      const peer = await client.peers.create({
        name: "new-device",
        server_id: MOCK_SERVER._id,
      });

      expect(peer.name).toBe("new-device");
      expect(peer.server_id).toBe(MOCK_SERVER._id);
      expect(peer.ip).toBeDefined();
      expect(peer.public_key).toBeDefined();
      expect(peer.private_key).toBeDefined(); // controller-generated
    });

    it("should create a peer with user-provided public key", async () => {
      const client = createClient();
      const peer = await client.peers.create({
        name: "byok-device",
        server_id: MOCK_SERVER._id,
        public_key: "UserProvidedKey==",
      });

      expect(peer.public_key).toBe("UserProvidedKey==");
      expect(peer.private_key).toBeUndefined(); // user manages their own key
    });

    it("should throw on missing name", async () => {
      const client = createClient();
      await expect(
        client.peers.create({ name: "", server_id: MOCK_SERVER._id }),
      ).rejects.toThrow("name is required");
    });

    it("should throw on missing server_id", async () => {
      const client = createClient();
      await expect(
        client.peers.create({ name: "test", server_id: "" }),
      ).rejects.toThrow("server_id is required");
    });
  });

  describe("update", () => {
    it("should update peer fields", async () => {
      const client = createClient();
      const updated = await client.peers.update(MOCK_PEER._id, {
        name: "john-desktop",
        enabled: false,
      });

      expect(updated._id).toBe(MOCK_PEER._id);
      expect(updated.name).toBe("john-desktop");
      expect(updated.enabled).toBe(false);
    });

    it("should throw on non-existent peer", async () => {
      const client = createClient();
      await expect(
        client.peers.update("nonexistent", { name: "test" }),
      ).rejects.toThrow();
    });
  });

  describe("delete", () => {
    it("should delete a peer", async () => {
      const client = createClient();
      await expect(client.peers.delete(MOCK_PEER._id)).resolves.not.toThrow();

      // Verify peer is gone
      const peers = await client.peers.list();
      expect(peers.find((p) => p._id === MOCK_PEER._id)).toBeUndefined();
    });
  });
});
