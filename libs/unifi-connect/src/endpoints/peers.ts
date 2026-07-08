import type {
  WgPeer,
  CreateWgPeerRequest,
  UpdateWgPeerRequest,
} from "../types/peer.js";
import type { UniFiClient } from "../client.js";
import { NotFoundError } from "../errors.js";

interface V2WgUser {
  readonly _id: string;
  readonly name: string;
  readonly network_id: string;
  readonly interface_ip: string;
  readonly public_key: string;
  readonly preshared_key?: string;
  readonly allowed_ips: readonly string[];
}

function v2Path(site: string, serverId?: string): string {
  const base = `/proxy/network/v2/api/site/${site}/wireguard`;
  return serverId ? `${base}/${serverId}/users` : `${base}/users`;
}

function toWgPeer(u: V2WgUser): WgPeer {
  return {
    _id: u._id,
    name: u.name,
    server_id: u.network_id,
    ip: u.interface_ip,
    public_key: u.public_key,
    preshared_key: u.preshared_key,
    allowed_ips: u.allowed_ips ?? [],
    enabled: true,
  };
}

export class PeerEndpoints {
  private readonly client: UniFiClient;
  private readonly site: string;

  constructor(client: UniFiClient, site = "default") {
    this.client = client;
    this.site = site;
  }

  async list(serverId?: string): Promise<readonly WgPeer[]> {
    const path = v2Path(this.site, serverId);
    const users = await this.client.rawRequest<readonly V2WgUser[]>("GET", path);
    return users.map(toWgPeer);
  }

  async get(id: string): Promise<WgPeer> {
    // List all and filter — v2 API doesn't have a single-user GET
    const all = await this.list();
    const peer = all.find((p) => p._id === id);
    if (!peer) throw new NotFoundError("WireGuard peer", id);
    return peer;
  }

  async create(request: CreateWgPeerRequest): Promise<WgPeer> {
    if (!request.name) throw new Error("Peer name is required");
    if (!request.server_id) throw new Error("Peer server_id is required");

    const path = `${v2Path(this.site, request.server_id)}/batch`;
    const payload = [{
      name: request.name,
      interface_ip: request.ip ?? "",
      public_key: request.public_key ?? "",
      ...(request.preshared_key ? { preshared_key: request.preshared_key } : {}),
      ...(request.allowed_ips ? { allowed_ips: request.allowed_ips } : {}),
    }];

    const created = await this.client.rawRequest<readonly V2WgUser[]>("POST", path, payload);
    const user = created[0];
    if (!user) throw new Error("No peer returned from create operation");
    return toWgPeer(user);
  }

  async update(id: string, request: UpdateWgPeerRequest): Promise<WgPeer> {
    // Find the peer first to get its server_id
    const existing = await this.get(id);
    const path = `${v2Path(this.site, existing.server_id)}/batch`;
    const payload = [{
      _id: id,
      ...request,
      ...(request.ip ? { interface_ip: request.ip } : {}),
      ...(request.public_key ? { public_key: request.public_key } : {}),
    }];

    const updated = await this.client.rawRequest<readonly V2WgUser[]>("PUT", path, payload);
    const user = updated[0];
    if (!user) throw new NotFoundError("WireGuard peer", id);
    return toWgPeer(user);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    const path = `${v2Path(this.site, existing.server_id)}/batch_delete`;
    await this.client.rawRequest<unknown>("POST", path, [id]);
  }
}
