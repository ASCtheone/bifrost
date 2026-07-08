import setCookieParser from "set-cookie-parser";
import type { SessionState, UniFiConnectionConfig } from "./types/config.js";
import { AuthError, NetworkError } from "./errors.js";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes conservative estimate

export async function login(
  config: UniFiConnectionConfig,
  agent?: { dispatcher?: unknown },
): Promise<SessionState> {
  const baseUrl = buildBaseUrl(config);
  const url = `${baseUrl}/api/auth/login`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: config.username,
        password: config.password,
      }),
      ...(agent ?? {}),
    } as RequestInit);
  } catch (error) {
    throw new NetworkError(
      `Failed to connect to UniFi controller at ${config.host}`,
      error instanceof Error ? error : undefined,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError("Invalid credentials");
  }

  if (!response.ok) {
    throw new AuthError(
      `Login failed with status ${response.status}`,
    );
  }

  const cookie = extractCookie(response);
  const csrfToken = extractCsrfToken(response, cookie);

  if (!cookie) {
    throw new AuthError("No session cookie received from UniFi controller");
  }

  return {
    cookie,
    csrfToken: csrfToken ?? "",
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}

export function isSessionValid(session: SessionState | null): boolean {
  if (!session) return false;
  return Date.now() < session.expiresAt;
}

export function buildBaseUrl(config: UniFiConnectionConfig): string {
  const port = config.port ?? 443;
  if (port === 443) {
    return `https://${config.host}`;
  }
  return `https://${config.host}:${port}`;
}

export function buildApiPath(config: UniFiConnectionConfig): string {
  const site = config.site ?? "default";
  return `/proxy/network/api/s/${site}`;
}

function extractCookie(response: Response): string {
  const setCookieHeader = response.headers.get("set-cookie");
  if (!setCookieHeader) return "";

  const cookies = setCookieParser.parse(
    setCookieParser.splitCookiesString(setCookieHeader),
  );

  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function extractCsrfToken(
  response: Response,
  _cookie: string,
): string | undefined {
  // Check response header first
  const headerToken = response.headers.get("x-csrf-token");
  if (headerToken) return headerToken;

  // Some firmware versions include it in a custom header
  const updatedToken = response.headers.get("x-updated-csrf-token");
  if (updatedToken) return updatedToken;

  return undefined;
}
