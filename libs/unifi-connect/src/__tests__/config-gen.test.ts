import { describe, it, expect } from "vitest";
import { generatePeerConfig } from "../config-gen.js";
import { MOCK_SERVER, MOCK_PEER, MOCK_PEER_NO_KEY } from "./helpers/fixtures.js";

describe("generatePeerConfig", () => {
  it("should generate a valid WireGuard client config", () => {
    const conf = generatePeerConfig(MOCK_SERVER, MOCK_PEER);

    expect(conf).toContain("[Interface]");
    expect(conf).toContain(`PrivateKey = ${MOCK_PEER.private_key}`);
    expect(conf).toContain(`Address = ${MOCK_PEER.ip}/32`);
    expect(conf).toContain("DNS = 1.1.1.1, 8.8.8.8");
    expect(conf).toContain("MTU = 1420");

    expect(conf).toContain("[Peer]");
    expect(conf).toContain(`PublicKey = ${MOCK_SERVER.server_public_key}`);
    expect(conf).toContain(`PresharedKey = ${MOCK_PEER.preshared_key}`);
    expect(conf).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
    expect(conf).toContain("Endpoint = 203.0.113.1:51820");
    expect(conf).toContain("PersistentKeepalive = 25");
  });

  it("should omit PresharedKey if not set", () => {
    const peerNoPsk = { ...MOCK_PEER, preshared_key: undefined };
    const conf = generatePeerConfig(MOCK_SERVER, peerNoPsk);

    expect(conf).not.toContain("PresharedKey");
  });

  it("should omit Endpoint if host_address is not set", () => {
    const serverNoHost = { ...MOCK_SERVER, host_address: undefined };
    const conf = generatePeerConfig(serverNoHost, MOCK_PEER);

    expect(conf).not.toContain("Endpoint");
  });

  it("should omit DNS if server has no DNS configured", () => {
    const serverNoDns = { ...MOCK_SERVER, dns: [] };
    const conf = generatePeerConfig(serverNoDns, MOCK_PEER);

    expect(conf).not.toContain("DNS");
  });

  it("should omit MTU if zero", () => {
    const serverNoMtu = { ...MOCK_SERVER, mtu: 0 };
    const conf = generatePeerConfig(serverNoMtu, MOCK_PEER);

    expect(conf).not.toContain("MTU");
  });

  it("should throw if peer has no private_key", () => {
    expect(() => generatePeerConfig(MOCK_SERVER, MOCK_PEER_NO_KEY)).toThrow(
      "private_key is missing",
    );
  });

  it("should produce a properly formatted config string", () => {
    const conf = generatePeerConfig(MOCK_SERVER, MOCK_PEER);
    const lines = conf.trim().split("\n");

    // First line should be [Interface]
    expect(lines[0]).toBe("[Interface]");

    // Should have a blank line separating Interface and Peer sections
    const blankIdx = lines.indexOf("");
    expect(blankIdx).toBeGreaterThan(0);
    expect(lines[blankIdx + 1]).toBe("[Peer]");

    // Should end with a newline
    expect(conf.endsWith("\n")).toBe(true);
  });
});
