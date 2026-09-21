import { createServer } from "node:http";
import { installShutdown, requiredEnvironment as required } from "../deployment/process.ts";
import { createSupervisorClient } from "../supervisor/control.ts";
import { createOidcAuthenticator } from "./auth.ts";
import { DiscordAdapter } from "./discord.ts";
import { startGateway } from "./index.ts";
import { createFileMembership } from "./membership.ts";

const membership = createFileMembership(required("PUNCH_MEMBERSHIP_FILE"));
const authenticate = createOidcAuthenticator({
	issuer: required("PUNCH_OIDC_ISSUER"),
	audience: required("PUNCH_OIDC_AUDIENCE"),
	jwksUrl: required("PUNCH_OIDC_JWKS_URL"),
	requiredScopes: required("PUNCH_OIDC_SCOPES").split(" "),
	async resolvePrincipal(claims) {
		return membership.oidc(claims.sub!);
	},
});
const discord = process.env.PUNCH_DISCORD_APPLICATION_ID
	? new DiscordAdapter({
			applicationId: required("PUNCH_DISCORD_APPLICATION_ID"),
			publicKey: required("PUNCH_DISCORD_PUBLIC_KEY"),
			botToken: required("PUNCH_DISCORD_BOT_TOKEN"),
			resolvePrincipal: (identity) => membership.discord(identity),
			onError: console.error,
		})
	: undefined;
const httpServer = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (request, response) => {
	if (request.url === "/discord" && discord) {
		void discord.handleNode(request, response);
		return;
	}
	response.writeHead(404).end();
});
const gateway = await startGateway({
	serverId: required("PUNCH_GATEWAY_ID"),
	databasePath: required("PUNCH_GATEWAY_DATABASE"),
	httpServer,
	supervisor: createSupervisorClient(required("PUNCH_SUPERVISOR_URL"), required("PUNCH_SUPERVISOR_TOKEN")),
	websocket: { authenticate },
	adapters: discord ? [discord] : [],
	authorizePrincipal: membership.authorize,
	onError: console.error,
});
const close = async (): Promise<void> => {
	try {
		await gateway.close();
	} finally {
		await new Promise<void>((resolve) => {
			httpServer.close(() => resolve());
			httpServer.closeAllConnections();
		});
	}
};
try {
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(8082, "0.0.0.0", resolve);
	});
	installShutdown(close, 30_000);
} catch (error) {
	await close();
	throw error;
}
