export interface UniFiConnectionConfig {
  readonly host: string;
  readonly port?: number;
  readonly site?: string;
  readonly username?: string;
  readonly password?: string;
  readonly apiKey?: string;
  readonly rejectUnauthorized?: boolean;
}

export interface SessionState {
  readonly cookie: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
}
