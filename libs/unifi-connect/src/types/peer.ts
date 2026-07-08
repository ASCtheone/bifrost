export interface WgPeer {
  readonly _id: string;
  readonly name: string;
  readonly server_id: string;
  readonly ip: string;
  readonly public_key: string;
  readonly private_key?: string;
  readonly preshared_key?: string;
  readonly allowed_ips: readonly string[];
  readonly enabled: boolean;
  readonly rx_bytes?: number;
  readonly tx_bytes?: number;
  readonly last_handshake?: number;
}

export interface CreateWgPeerRequest {
  readonly name: string;
  readonly server_id: string;
  readonly ip?: string;
  readonly public_key?: string;
  readonly preshared_key?: string;
  readonly allowed_ips?: readonly string[];
  readonly enabled?: boolean;
}

export interface UpdateWgPeerRequest {
  readonly name?: string;
  readonly ip?: string;
  readonly public_key?: string;
  readonly preshared_key?: string;
  readonly allowed_ips?: readonly string[];
  readonly enabled?: boolean;
}
