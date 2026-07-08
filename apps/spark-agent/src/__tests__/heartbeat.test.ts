import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
vi.stubGlobal("fetch", mockFetch);

const mockBridge = {
  readSnapshot: vi.fn().mockResolvedValue({ servers: [], peers: [] }),
};

import { Heartbeat } from "../heartbeat.js";

describe("Heartbeat", () => {
  let heartbeat: Heartbeat;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockClear();
    mockBridge.readSnapshot.mockClear();
    heartbeat = new Heartbeat(
      "test-node",
      1000,
      "https://api.example.com",
      "test-node-key",
      mockBridge as never,
    );
  });

  afterEach(() => {
    heartbeat.stop();
    vi.useRealTimers();
  });

  it("should register node via API with snapshot", async () => {
    await heartbeat.register();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockBridge.readSnapshot).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.example.com/nodes/test-node/heartbeat",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          "X-Node-Key": "test-node-key",
        }),
      }),
    );
  });

  it("should send heartbeats on interval", async () => {
    heartbeat.start();
    mockFetch.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("should stop sending heartbeats after stop()", async () => {
    heartbeat.start();
    mockFetch.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    heartbeat.stop();
    mockFetch.mockClear();

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should not start multiple timers", () => {
    heartbeat.start();
    heartbeat.start();
    heartbeat.stop();
  });
});
