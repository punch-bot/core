import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@punch-bot/ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
/** MCP endpoint of the gateway the built-in Radius provider signs in to. */
export const RADIUS_MCP_URL = `${normalizeRadiusGatewayUrl(DEFAULT_RADIUS_GATEWAY)}/mcp`;
