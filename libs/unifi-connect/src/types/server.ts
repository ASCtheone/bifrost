export interface WgServer {
  readonly _id: string;
  readonly name: string;
  readonly interface: string;
  readonly server_address: string;
  readonly server_port: number;
  readonly server_private_key: string;
  readonly server_public_key: string;
  readonly dns: readonly string[];
  readonly mtu: number;
  readonly enabled: boolean;
  readonly host_address?: string;
  readonly route_allowed_ips?: boolean;
}

// networkconf shape for WireGuard servers (newer firmware)
export interface NetworkConfVpn {
  readonly _id: string;
  readonly name: string;
  readonly purpose: string;
  readonly vpn_type: string;
  readonly wireguard_id?: number;
  readonly local_port?: number;
  readonly wireguard_interface?: string;
  readonly wireguard_local_wan_ip?: string;
  readonly wireguard_public_key?: string;
  readonly x_wireguard_private_key?: string;
  readonly vpn_binding_mode?: string;
  readonly subnet_cidr?: string;
  readonly ip_subnet?: string;
  readonly enabled?: boolean;
}
