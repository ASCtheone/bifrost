import type { WgServer } from "../../types/server.js";
import type { WgPeer } from "../../types/peer.js";

export const MOCK_SERVER: WgServer = {
  _id: "6601a1b2c3d4e5f6a7b8c9d0",
  name: "bifrost-wg0",
  interface: "wg0",
  server_address: "10.0.0.1/24",
  server_port: 51820,
  server_private_key: "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=",
  server_public_key: "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=",
  dns: ["1.1.1.1", "8.8.8.8"],
  mtu: 1420,
  enabled: true,
  host_address: "203.0.113.1",
  route_allowed_ips: true,
};

export const MOCK_PEER: WgPeer = {
  _id: "6601a1b2c3d4e5f6a7b8c9d1",
  name: "john-laptop",
  server_id: "6601a1b2c3d4e5f6a7b8c9d0",
  ip: "10.0.0.2",
  public_key: "HIgo9xNzJMWLKASShiTqIybxR0V1tB1ZA2YKQA3hUWM=",
  private_key: "gI6EdUSYvn8ugXOt8QQD6Yc+JyiZi6DPfSoKjh8F2mI=",
  preshared_key: "e16lsZBPPDHPHR2g0HP8G/P8YCniqMhRqLH01ciWnVA=",
  allowed_ips: ["0.0.0.0/0", "::/0"],
  enabled: true,
  rx_bytes: 1234567,
  tx_bytes: 7654321,
  last_handshake: 1710600000,
};

export const MOCK_PEER_NO_KEY: WgPeer = {
  ...MOCK_PEER,
  _id: "6601a1b2c3d4e5f6a7b8c9d2",
  name: "jane-phone",
  ip: "10.0.0.3",
  private_key: undefined,
};

export function wrapResponse<T>(data: T[]) {
  return {
    meta: { rc: "ok" as const },
    data,
  };
}

export function errorResponse(msg: string) {
  return {
    meta: { rc: "error" as const, msg },
    data: [],
  };
}
