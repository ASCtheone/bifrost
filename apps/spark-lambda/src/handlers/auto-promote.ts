import {
  getSystemConfig,
  queryNodesByRole,
  queryOnlineSecondariesByPriority,
  updateNodeRole,
  writeAuditLog,
} from "@bifrost/dynamo-repo";

export async function handler() {
  const config = await getSystemConfig();

  if (!config.autoPromoteEnabled) {
    return;
  }

  const primaries = await queryNodesByRole("primary");

  if (primaries.length === 0) {
    await promoteNextSecondary("system:no_primary");
    return;
  }

  const primary = primaries[0]!;
  const lastSeenMs = new Date(primary.lastSeen).getTime();
  const staleSince = (Date.now() - lastSeenMs) / 1000;

  if (staleSince > config.autoPromoteStaleSeconds) {
    // Demote stale primary
    await updateNodeRole(primary.nodeId, "secondary", primary.priority);

    await writeAuditLog("node.demoted", "system:auto_promote", primary.nodeId, {
      reason: "stale",
      staleSince: Math.round(staleSince),
    });

    await promoteNextSecondary("system:auto_promote");
  }
}

async function promoteNextSecondary(actor: string): Promise<void> {
  const secondaries = await queryOnlineSecondariesByPriority(1);

  if (secondaries.length === 0) {
    return;
  }

  const next = secondaries[0]!;
  await updateNodeRole(next.nodeId, "primary", next.priority);

  await writeAuditLog("node.auto_promoted", actor, next.nodeId, {
    priority: next.priority,
  });
}
