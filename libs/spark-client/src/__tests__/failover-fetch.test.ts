import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { NodeSelector } from "../node-selector.js";
import { FailoverFetch } from "../failover-fetch.js";
import type { SparkNode } from "../types.js";

function makeNode(id: string, role: "primary" | "secondary"): SparkNode {
  return {
    id,
    tunnelUrl: `https://${id}.test`,
    role,
    status: "online",
  };
}

const mockServer = setupServer(
  http.get("https://a.test/health", () =>
    HttpResponse.json({ status: "ok", nodeId: "a" }),
  ),
  http.get("https://b.test/health", () =>
    HttpResponse.json({ status: "ok", nodeId: "b" }),
  ),
  http.get("https://a.test/fail", () =>
    new HttpResponse(null, { status: 500 }),
  ),
  http.get("https://b.test/fail", () =>
    new HttpResponse(null, { status: 500 }),
  ),
  http.post("https://a.test/peers", async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json({ id: "peer-1", ...(body as object) });
  }),
);

beforeAll(() => mockServer.listen());
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

describe("FailoverFetch", () => {
  it("should make request to primary node", async () => {
    const selector = new NodeSelector();
    selector.updateNodes([makeNode("a", "primary"), makeNode("b", "secondary")]);
    const fetcher = new FailoverFetch(selector, "test-token");

    const result = await fetcher.request<{ nodeId: string }>("/health");
    expect(result.nodeId).toBe("a");
  });

  it("should failover to secondary when primary fails", async () => {
    const selector = new NodeSelector();
    selector.updateNodes([makeNode("a", "primary"), makeNode("b", "secondary")]);
    const fetcher = new FailoverFetch(selector, "test-token");

    // Primary returns 500 for /fail, secondary also returns 500
    // But for /health, both work — let's test with a handler that
    // makes only primary fail
    mockServer.use(
      http.get("https://a.test/health", () =>
        new HttpResponse(null, { status: 503 }),
      ),
    );

    const result = await fetcher.request<{ nodeId: string }>("/health");
    expect(result.nodeId).toBe("b");
  });

  it("should throw if all nodes fail", async () => {
    const selector = new NodeSelector();
    selector.updateNodes([makeNode("a", "primary"), makeNode("b", "secondary")]);
    const fetcher = new FailoverFetch(selector, "test-token");

    await expect(fetcher.request("/fail")).rejects.toThrow("HTTP 500");
  });

  it("should send POST with body", async () => {
    const selector = new NodeSelector();
    selector.updateNodes([makeNode("a", "primary")]);
    const fetcher = new FailoverFetch(selector, "test-token");

    const result = await fetcher.request<{ id: string; name: string }>("/peers", {
      method: "POST",
      body: { name: "test-peer" },
    });

    expect(result.id).toBe("peer-1");
    expect(result.name).toBe("test-peer");
  });

  it("should throw if no nodes available", async () => {
    const selector = new NodeSelector();
    const fetcher = new FailoverFetch(selector, "test-token");

    await expect(fetcher.request("/health")).rejects.toThrow("No nodes available");
  });
});
