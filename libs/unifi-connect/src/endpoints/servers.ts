import { createPrivateKey, createPublicKey } from "node:crypto";
import type { WgServer, NetworkConfVpn } from "../types/server.js";
import type { UniFiClient } from "../client.js";

function derivePublicKey(privKeyB64: string): string {
  try {
    const privBytes = Buffer.from(privKeyB64, "base64");
    const pkcs8Header = Buffer.from("302e020100300506032b656e04220420", "hex");
    const privKey = createPrivateKey({
      key: Buffer.concat([pkcs8Header, privBytes]),
      format: "der",
      type: "pkcs8",
    });
    const pubKey = createPublicKey(privKey);
    return pubKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  } catch {
    return "";
  }
}

export class ServerEndpoints {
  private readonly client: UniFiClient;

  constructor(client: UniFiClient) {
    this.client = client;
  }

  async list(): Promise<readonly WgServer[]> {
    // Try legacy endpoint first
    try {
      const servers = await this.client.get<WgServer>("/rest/wg/server");
      if (servers.length > 0) return servers;
    } catch {
      // Fall through to networkconf approach
    }

    // Newer firmware: WireGuard servers live in networkconf
    return this.listFromNetworkConf();
  }

  async listFromNetworkConf(): Promise<readonly WgServer[]> {
    const allNetworks = await this.client.get<NetworkConfVpn>("/rest/networkconf");
    const wgServers = allNetworks.filter(
      (n) => n.vpn_type === "wireguard-server",
    );

    return wgServers.map((n) => ({
      _id: n._id,
      name: n.name,
      interface: n.wireguard_interface ?? "wan",
      server_address: n.ip_subnet ?? n.subnet_cidr ?? "",
      server_port: n.local_port ?? n.wireguard_id ?? 0,
      server_private_key: n.x_wireguard_private_key ?? "",
      server_public_key: n.wireguard_public_key || (n.x_wireguard_private_key ? derivePublicKey(n.x_wireguard_private_key) : ""),
      dns: [],
      mtu: 0,
      enabled: n.enabled !== false,
    }));
  }

  async createFromNetworkConf(
    name: string,
    opts?: { subnet?: string; port?: number },
  ): Promise<NetworkConfVpn> {
    // Generate WireGuard keypair
    const { privateKey } = await import("node:crypto").then((c) => {
      const kp = c.generateKeyPairSync("x25519");
      return {
        privateKey: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
      };
    });

    // Find a free port (start at 51830, skip used ones)
    const existing = await this.listFromNetworkConf();
    const usedPorts = new Set(existing.map((s) => s.server_port));
    let port = opts?.port ?? 51830;
    while (usedPorts.has(port)) port++;

    // Find a free subnet (start at 192.168.8.1/24, skip used ones)
    const usedSubnets = new Set(existing.map((s) => s.server_address));
    let subnetOctet = 8;
    let subnet = opts?.subnet ?? `192.168.${subnetOctet}.1/24`;
    while (usedSubnets.has(subnet)) {
      subnetOctet++;
      subnet = `192.168.${subnetOctet}.1/24`;
    }

    const data = await this.client.post<NetworkConfVpn>("/rest/networkconf", {
      name,
      purpose: "remote-user-vpn",
      vpn_type: "wireguard-server",
      wireguard_interface: "wan",
      wireguard_local_wan_ip: "any",
      vpn_binding_mode: "any",
      local_port: port,
      ip_subnet: subnet,
      x_wireguard_private_key: privateKey,
    });
    const created = data[0];
    if (!created) {
      throw new Error("No VPN server returned from create operation");
    }
    return created;
  }

  async get(id: string): Promise<WgServer> {
    const data = await this.client.get<WgServer>(`/rest/wg/server/${id}`);
    const server = data[0];
    if (!server) {
      // Try networkconf fallback
      const allNetworks = await this.client.get<NetworkConfVpn>("/rest/networkconf");
      const match = allNetworks.find((n) => n._id === id && n.vpn_type === "wireguard-server");
      if (!match) throw new Error(`WireGuard server not found: ${id}`);
      return {
        _id: match._id,
        name: match.name,
        interface: match.wireguard_interface ?? "wan",
        server_address: match.subnet_cidr ?? match.ip_subnet ?? "",
        server_port: match.wireguard_id ?? 0,
        server_private_key: match.x_wireguard_private_key ?? "",
        server_public_key: match.wireguard_public_key ?? "",
        dns: [],
        mtu: 0,
        enabled: match.enabled !== false,
      };
    }
    return server;
  }
}
