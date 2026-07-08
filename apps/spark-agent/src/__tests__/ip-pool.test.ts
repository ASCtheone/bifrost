import { describe, it, expect, vi } from "vitest";

const mockAllocateIp = vi.fn();
const mockReleaseIp = vi.fn();

// Mock @bifrost/dynamo-repo
vi.mock("@bifrost/dynamo-repo", () => ({
  allocateIp: (...args: unknown[]) => mockAllocateIp(...args),
  releaseIp: (...args: unknown[]) => mockReleaseIp(...args),
}));

import { allocateIp } from "../api/ip-pool.js";

describe("IP Pool", () => {
  it("should allocate an IP from the pool", async () => {
    mockAllocateIp.mockResolvedValueOnce("10.0.0.2");

    const ip = await allocateIp("10.0.0.0_24", "peer-1");

    expect(ip).toBe("10.0.0.2");
    expect(mockAllocateIp).toHaveBeenCalledWith("10.0.0.0_24", "peer-1");
  });

  it("should allocate different IPs for different peers", async () => {
    mockAllocateIp.mockResolvedValueOnce("10.0.0.3");
    mockAllocateIp.mockResolvedValueOnce("10.0.0.4");

    const ip1 = await allocateIp("10.0.0.0_24", "peer-2");
    const ip2 = await allocateIp("10.0.0.0_24", "peer-3");

    expect(ip1).toBe("10.0.0.3");
    expect(ip2).toBe("10.0.0.4");
    expect(ip1).not.toBe(ip2);
  });
});
