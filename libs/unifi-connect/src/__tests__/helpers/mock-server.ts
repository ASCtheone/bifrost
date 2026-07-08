import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  MOCK_SERVER,
  MOCK_PEER,
  wrapResponse,
  errorResponse,
} from "./fixtures.js";
import type { WgPeer } from "../../types/peer.js";

const BASE = "https://192.168.1.1";
const API = `${BASE}/proxy/network/api/s/default`;

let authValid = true;
let peers = [MOCK_PEER];

export function setAuthValid(valid: boolean) {
  authValid = valid;
}

export function resetPeers() {
  peers = [{ ...MOCK_PEER }];
}

export const handlers = [
  // Auth
  http.post(`${BASE}/api/auth/login`, async ({ request }) => {
    const body = (await request.json()) as {
      username: string;
      password: string;
    };

    if (body.username === "admin" && body.password === "password") {
      return HttpResponse.json(
        { meta: { rc: "ok" }, data: [] },
        {
          headers: {
            "Set-Cookie": "TOKEN=abc123; Path=/; HttpOnly; Secure",
            "x-csrf-token": "csrf-token-xyz",
          },
        },
      );
    }

    return HttpResponse.json(
      { meta: { rc: "error", msg: "api.err.Invalid" }, data: [] },
      { status: 401 },
    );
  }),

  http.post(`${BASE}/api/auth/logout`, () => {
    return HttpResponse.json({ meta: { rc: "ok" }, data: [] });
  }),

  // WG Servers
  http.get(`${API}/rest/wg/server`, ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json(errorResponse("Unauthorized"), { status: 401 });
    }
    return HttpResponse.json(wrapResponse([MOCK_SERVER]));
  }),

  http.get(`${API}/rest/wg/server/:id`, ({ request, params }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json(errorResponse("Unauthorized"), { status: 401 });
    }
    if (params["id"] === MOCK_SERVER._id) {
      return HttpResponse.json(wrapResponse([MOCK_SERVER]));
    }
    return HttpResponse.json(wrapResponse([]), { status: 404 });
  }),

  // WG Peers
  http.get(`${API}/rest/wg/peer`, ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json(errorResponse("Unauthorized"), { status: 401 });
    }
    return HttpResponse.json(wrapResponse(peers));
  }),

  http.get(`${API}/rest/wg/peer/:id`, ({ request, params }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json(errorResponse("Unauthorized"), { status: 401 });
    }
    const peer = peers.find((p) => p._id === params["id"]);
    if (peer) {
      return HttpResponse.json(wrapResponse([peer]));
    }
    return HttpResponse.json(wrapResponse([]), { status: 404 });
  }),

  http.post(`${API}/rest/wg/peer`, async ({ request }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json(errorResponse("Unauthorized"), { status: 401 });
    }
    const body = (await request.json()) as Partial<WgPeer>;
    const newPeer: WgPeer = {
      _id: `generated-${Date.now()}`,
      name: body.name ?? "unnamed",
      server_id: body.server_id ?? "",
      ip: body.ip ?? "10.0.0.99",
      public_key: body.public_key ?? "GeneratedPubKey==",
      private_key: body.public_key ? undefined : "GeneratedPrivKey==",
      preshared_key: body.preshared_key,
      allowed_ips: body.allowed_ips ?? ["0.0.0.0/0"],
      enabled: body.enabled ?? true,
    };
    peers.push(newPeer);
    return HttpResponse.json(wrapResponse([newPeer]));
  }),

  http.put(`${API}/rest/wg/peer/:id`, async ({ request, params }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json(errorResponse("Unauthorized"), { status: 401 });
    }
    const idx = peers.findIndex((p) => p._id === params["id"]);
    if (idx === -1) {
      return HttpResponse.json(wrapResponse([]), { status: 404 });
    }
    const body = (await request.json()) as Partial<WgPeer>;
    const updated: WgPeer = { ...peers[idx]!, ...body, _id: peers[idx]!._id };
    peers[idx] = updated;
    return HttpResponse.json(wrapResponse([updated]));
  }),

  http.delete(`${API}/rest/wg/peer/:id`, ({ request, params }) => {
    if (!checkAuth(request)) {
      return HttpResponse.json(errorResponse("Unauthorized"), { status: 401 });
    }
    const idx = peers.findIndex((p) => p._id === params["id"]);
    if (idx === -1) {
      return HttpResponse.json(wrapResponse([]), { status: 404 });
    }
    peers.splice(idx, 1);
    return HttpResponse.json(wrapResponse([]));
  }),
];

function checkAuth(request: Request): boolean {
  if (!authValid) return false;
  const cookie = request.headers.get("Cookie");
  return cookie !== null && cookie.includes("TOKEN=");
}

export const server = setupServer(...handlers);
