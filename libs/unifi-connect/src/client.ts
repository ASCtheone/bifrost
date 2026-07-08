import type { UniFiConnectionConfig, SessionState } from "./types/config.js";
import type { UniFiResponse } from "./types/api.js";
import { login, isSessionValid, buildBaseUrl, buildApiPath } from "./auth.js";
import { AuthError, NetworkError, UniFiApiError } from "./errors.js";
import { withRetry } from "./utils.js";
import { ServerEndpoints } from "./endpoints/servers.js";
import { PeerEndpoints } from "./endpoints/peers.js";

export class UniFiClient {
  private readonly config: UniFiConnectionConfig;
  private readonly baseUrl: string;
  private readonly apiPath: string;
  private session: SessionState | null = null;

  readonly servers: ServerEndpoints;
  readonly peers: PeerEndpoints;

  constructor(config: UniFiConnectionConfig) {
    this.config = config;
    this.baseUrl = buildBaseUrl(config);
    this.apiPath = buildApiPath(config);
    this.servers = new ServerEndpoints(this);
    this.peers = new PeerEndpoints(this, config.site ?? "default");
  }

  async get<T>(path: string): Promise<readonly T[]> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<readonly T[]> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<readonly T[]> {
    return this.request<T>("PUT", path, body);
  }

  async delete<T>(path: string): Promise<readonly T[]> {
    return this.request<T>("DELETE", path);
  }

  async ensureAuth(): Promise<void> {
    // API key auth skips session login
    if (this.config.apiKey) return;
    if (!isSessionValid(this.session)) {
      this.session = await login(this.config);
    }
  }

  async logout(): Promise<void> {
    if (!this.session) return;

    try {
      await fetch(`${this.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: this.buildHeaders(),
      } as RequestInit);
    } catch {
      // Ignore logout errors
    }

    this.session = null;
  }

  /** Request through the standard /api/s/{site} path, returns data[] array */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<readonly T[]> {
    return withRetry(async () => {
      return this.doRequest<T>(method, path, body);
    });
  }

  /** Request to an absolute path (e.g. v2 API), returns raw parsed JSON */
  async rawRequest<T>(method: string, absolutePath: string, body?: unknown): Promise<T> {
    return withRetry(async () => {
      await this.ensureAuth();

      const url = `${this.baseUrl}${absolutePath}`;
      let response: Response;

      try {
        response = await fetch(url, {
          method,
          headers: this.buildHeaders(),
          body: body ? JSON.stringify(body) : undefined,
        } as RequestInit);
      } catch (error) {
        throw new NetworkError(
          `Request failed: ${method} ${absolutePath}`,
          error instanceof Error ? error : undefined,
        );
      }

      if (response.status === 401) {
        this.session = null;
        throw new AuthError("Session expired");
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new UniFiApiError(
          response.status,
          `${method} ${absolutePath} failed: ${response.status}`,
          text,
        );
      }

      return response.json() as Promise<T>;
    });
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    isReauth = false,
  ): Promise<readonly T[]> {
    await this.ensureAuth();

    const url = `${this.baseUrl}${this.apiPath}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body ? JSON.stringify(body) : undefined,
      } as RequestInit);
    } catch (error) {
      throw new NetworkError(
        `Request failed: ${method} ${path}`,
        error instanceof Error ? error : undefined,
      );
    }

    // On 401: clear session and retry once with fresh auth
    if (response.status === 401) {
      this.session = null;
      if (!isReauth) {
        return this.doRequest<T>(method, path, body, true);
      }
      throw new AuthError("Session expired after re-auth attempt");
    }

    // 404 returns empty data array — let endpoint handle "not found"
    if (response.status === 404) {
      return [] as unknown as readonly T[];
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new UniFiApiError(
        response.status,
        `${method} ${path} failed: ${response.status}`,
        text,
      );
    }

    const json = (await response.json()) as UniFiResponse<T>;

    if (json.meta.rc !== "ok") {
      throw new UniFiApiError(
        response.status,
        `API error: ${json.meta.msg ?? "unknown"}`,
        json.meta.msg,
      );
    }

    return json.data;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.apiKey) {
      headers["X-API-Key"] = this.config.apiKey;
    } else if (this.session) {
      headers["Cookie"] = this.session.cookie;
      if (this.session.csrfToken) {
        headers["x-csrf-token"] = this.session.csrfToken;
      }
    }

    return headers;
  }
}
