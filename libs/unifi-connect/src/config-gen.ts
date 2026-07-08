import type { WgServer } from "./types/server.js";
import type { WgPeer } from "./types/peer.js";

export function generatePeerConfig(server: WgServer, peer: WgPeer): string {
  if (!peer.private_key) {
    throw new Error(
      "Cannot generate client config: peer private_key is missing. " +
        "The key is only available when the UniFi controller generates it at peer creation time.",
    );
  }

  const lines: string[] = [];

  // [Interface] block
  lines.push("[Interface]");
  lines.push(`PrivateKey = ${peer.private_key}`);
  lines.push(`Address = ${peer.ip}/32`);

  if (server.dns.length > 0) {
    lines.push(`DNS = ${server.dns.join(", ")}`);
  }

  if (server.mtu > 0) {
    lines.push(`MTU = ${server.mtu}`);
  }

  // [Peer] block
  lines.push("");
  lines.push("[Peer]");
  lines.push(`PublicKey = ${server.server_public_key}`);

  if (peer.preshared_key) {
    lines.push(`PresharedKey = ${peer.preshared_key}`);
  }

  if (peer.allowed_ips.length > 0) {
    lines.push(`AllowedIPs = ${peer.allowed_ips.join(", ")}`);
  }

  if (server.host_address) {
    lines.push(`Endpoint = ${server.host_address}:${server.server_port}`);
  }

  lines.push("PersistentKeepalive = 25");

  return lines.join("\n") + "\n";
}
