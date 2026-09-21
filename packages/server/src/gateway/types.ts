import type { LaneTranscriptSnapshot } from "@punch-bot/agent";
import type { JsonValue } from "@punch-bot/chord";
import type { Principal } from "../principal.ts";
import type { ConversationKey, GatewayStore } from "./store.ts";

export type GatewayCommand =
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "new" }
	| { type: "attach"; sessionId: string }
	| { type: "model"; model: { provider: string; modelId: string } }
	| { type: "status" };

export interface Presentation {
	readonly principal: Principal;
	readonly conversation: ConversationKey;
	send(event: { type: "transcript"; sessionId: string; snapshot: LaneTranscriptSnapshot }): Promise<void>;
}

export interface GatewayPresentation {
	execute(eventId: string, command: GatewayCommand): Promise<JsonValue>;
	close(): Promise<void>;
}

export interface GatewayAdapterHost {
	readonly store: GatewayStore;
	open(presentation: Presentation): Promise<GatewayPresentation>;
}

export interface PlatformAdapter {
	start(gateway: GatewayAdapterHost): Promise<void>;
	stop(): Promise<void>;
}
