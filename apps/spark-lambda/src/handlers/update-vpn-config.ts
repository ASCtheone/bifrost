import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { updateVpnConfig, writeAuditLog } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";
import type { VpnServerConfig, VpnPeerDefaults } from "@bifrost/dynamo-schema";

interface UpdateVpnConfigInput {
  readonly server?: Partial<VpnServerConfig>;
  readonly defaults?: Partial<VpnPeerDefaults>;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const input = JSON.parse(event.body ?? "{}") as UpdateVpnConfigInput;

    if (!input.server && !input.defaults) {
      throw new HttpError(400, "No config fields provided");
    }

    await updateVpnConfig({
      server: input.server,
      defaults: input.defaults,
      updatedBy: auth.sub,
    });

    await writeAuditLog("config.updated", auth.sub, "vpnConfig", {
      fields: Object.keys(input),
    });

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
