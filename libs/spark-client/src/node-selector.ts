import type { SparkNode } from "./types.js";

export class NodeSelector {
  private nodes: readonly SparkNode[] = [];
  private currentIndex: number = 0;
  private readonly sticky: boolean;

  constructor(sticky: boolean = false) {
    this.sticky = sticky;
  }

  updateNodes(nodes: readonly SparkNode[]): void {
    const sorted = [...nodes].sort((a, b) => {
      if (a.role === "primary" && b.role !== "primary") return -1;
      if (a.role !== "primary" && b.role === "primary") return 1;
      return 0;
    });

    const currentNode = this.nodes[this.currentIndex];
    this.nodes = sorted;

    // If sticky and current node still exists, keep it
    if (this.sticky && currentNode) {
      const newIndex = sorted.findIndex((n) => n.id === currentNode.id);
      if (newIndex >= 0) {
        this.currentIndex = newIndex;
        return;
      }
    }

    // Otherwise reset to primary (index 0)
    this.currentIndex = 0;
  }

  current(): SparkNode | null {
    return this.nodes[this.currentIndex] ?? null;
  }

  failover(): SparkNode | null {
    if (this.nodes.length <= 1) return null;

    this.currentIndex = (this.currentIndex + 1) % this.nodes.length;
    return this.nodes[this.currentIndex] ?? null;
  }

  reset(): void {
    this.currentIndex = 0;
  }

  getAll(): readonly SparkNode[] {
    return this.nodes;
  }
}
