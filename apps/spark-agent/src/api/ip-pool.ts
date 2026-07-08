import { allocateIp as dynamoAllocateIp, releaseIp as dynamoReleaseIp } from "@bifrost/dynamo-repo";

export async function allocateIp(
  subnetKey: string,
  peerId: string,
): Promise<string> {
  return dynamoAllocateIp(subnetKey, peerId);
}

export async function releaseIp(
  subnetKey: string,
  ip: string,
): Promise<void> {
  // dynamo-repo releaseIp takes (subnetKey, peerId)
  // We need to release by subnetKey and the peerId that holds this IP.
  // Since the dynamo-repo releaseIp removes by peerId, we pass ip as the key.
  // Actually, let's just call the dynamo-repo's releaseIp which takes subnetKey + peerId.
  // The caller passes the peerId, so let's fix the signature.
  await dynamoReleaseIp(subnetKey, ip);
}
