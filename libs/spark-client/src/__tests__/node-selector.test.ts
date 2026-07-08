import { describe, it, expect, beforeEach } from "vitest";
import { NodeSelector } from "../node-selector.js";
import type { SparkNode } from "../types.js";

function makeNode(
  id: string,
  role: "primary" | "secondary",
  status: "online" | "offline" = "online",
): SparkNode {
  return { id, tunnelUrl: `https://${id}.bifrost.example.com`, role, status };
}

describe("NodeSelector", () => {
  let selector: NodeSelector;

  beforeEach(() => {
    selector = new NodeSelector();
  });

  describe("updateNodes", () => {
    it("should sort primary first", () => {
      selector.updateNodes([
        makeNode("b", "secondary"),
        makeNode("a", "primary"),
        makeNode("c", "secondary"),
      ]);

      const all = selector.getAll();
      expect(all[0]!.id).toBe("a");
      expect(all[0]!.role).toBe("primary");
    });

    it("should reset current index to primary", () => {
      selector.updateNodes([
        makeNode("b", "secondary"),
        makeNode("a", "primary"),
      ]);

      expect(selector.current()!.id).toBe("a");
    });
  });

  describe("failover", () => {
    it("should move to next node on failover", () => {
      selector.updateNodes([
        makeNode("a", "primary"),
        makeNode("b", "secondary"),
        makeNode("c", "secondary"),
      ]);

      expect(selector.current()!.id).toBe("a");

      const next = selector.failover();
      expect(next!.id).toBe("b");

      const next2 = selector.failover();
      expect(next2!.id).toBe("c");
    });

    it("should wrap around to first node", () => {
      selector.updateNodes([
        makeNode("a", "primary"),
        makeNode("b", "secondary"),
      ]);

      selector.failover(); // → b
      const wrapped = selector.failover(); // → a
      expect(wrapped!.id).toBe("a");
    });

    it("should return null if only one node", () => {
      selector.updateNodes([makeNode("a", "primary")]);
      expect(selector.failover()).toBeNull();
    });

    it("should return null if no nodes", () => {
      expect(selector.current()).toBeNull();
      expect(selector.failover()).toBeNull();
    });
  });

  describe("reset", () => {
    it("should go back to primary", () => {
      selector.updateNodes([
        makeNode("a", "primary"),
        makeNode("b", "secondary"),
      ]);

      selector.failover(); // → b
      expect(selector.current()!.id).toBe("b");

      selector.reset();
      expect(selector.current()!.id).toBe("a");
    });
  });

  describe("sticky mode", () => {
    it("should keep current node after updateNodes if sticky", () => {
      const sticky = new NodeSelector(true);
      sticky.updateNodes([
        makeNode("a", "primary"),
        makeNode("b", "secondary"),
      ]);

      sticky.failover(); // → b
      expect(sticky.current()!.id).toBe("b");

      // Update nodes — b still exists, sticky should keep it
      sticky.updateNodes([
        makeNode("a", "primary"),
        makeNode("b", "secondary"),
        makeNode("c", "secondary"),
      ]);

      expect(sticky.current()!.id).toBe("b");
    });

    it("should reset if current node removed in sticky mode", () => {
      const sticky = new NodeSelector(true);
      sticky.updateNodes([
        makeNode("a", "primary"),
        makeNode("b", "secondary"),
      ]);

      sticky.failover(); // → b

      // Update without b — should reset to primary
      sticky.updateNodes([
        makeNode("a", "primary"),
        makeNode("c", "secondary"),
      ]);

      expect(sticky.current()!.id).toBe("a");
    });
  });

  describe("role change handling", () => {
    it("should reflect new primary after promotion", () => {
      selector.updateNodes([
        makeNode("a", "primary"),
        makeNode("b", "secondary"),
      ]);

      // b gets promoted
      selector.updateNodes([
        makeNode("a", "secondary"),
        makeNode("b", "primary"),
      ]);

      expect(selector.current()!.id).toBe("b");
      expect(selector.current()!.role).toBe("primary");
    });

    it("should handle old primary returning as secondary", () => {
      selector.updateNodes([
        makeNode("b", "primary"),
        makeNode("c", "secondary"),
      ]);

      // a comes back as secondary
      selector.updateNodes([
        makeNode("a", "secondary"),
        makeNode("b", "primary"),
        makeNode("c", "secondary"),
      ]);

      // Primary is still b
      expect(selector.current()!.id).toBe("b");
      expect(selector.getAll()).toHaveLength(3);
    });
  });
});
