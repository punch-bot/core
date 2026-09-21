import type { LaneTranscriptSnapshot, OperationResultRecord } from "@punch-bot/agent";
import { type Context, defineService, type ReplicatedState } from "@punch-bot/chord";

export interface RuntimeSessionSummary {
	id: string;
	createdAt: number;
}
export interface RuntimeSessions {
	list(context: Context): Promise<RuntimeSessionSummary[]>;
	create(context: Context): Promise<RuntimeSessionSummary>;
	remove(id: string, context: Context): Promise<void>;
	attach(id: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}
export const RuntimeSessions = defineService<RuntimeSessions>("punch.runtime-sessions");

export interface RuntimeTranscript {
	readonly state: ReplicatedState<{ snapshot: LaneTranscriptSnapshot }>;
}
export const RuntimeTranscript = defineService<RuntimeTranscript>("punch.runtime-transcript");

export interface RuntimeModels {
	select(model: { provider: string; modelId: string }, context: Context): Promise<void>;
}
export const RuntimeModels = defineService<RuntimeModels>("punch.runtime-models");

export interface SandboxOperationStatus {
	readonly operationId: string;
	readonly status: "running" | "open" | "aborting" | "unknown" | OperationResultRecord["status"];
}

export interface SandboxOperations {
	accept(request: { operationId: string; text: string }, context: Context): Promise<SandboxOperationStatus>;
	status(operationId: string, context: Context): Promise<SandboxOperationStatus>;
	abort(operationId: string, context: Context): Promise<void>;
}
export const SandboxOperations = defineService<SandboxOperations>("punch.sandbox-operations");

export interface GatewaySessionSummary {
	sessionId: string;
	sandboxId: string;
	createdAt: number;
}
export interface GatewaySessions {
	list(context: Context): Promise<GatewaySessionSummary[]>;
	create(sandboxId: string | null, context: Context): Promise<GatewaySessionSummary>;
	remove(sessionId: string, context: Context): Promise<void>;
	attach(sessionId: string, context: Context): Promise<void>;
	detach(context: Context): Promise<void>;
}
export const GatewaySessions = defineService<GatewaySessions>("punch.gateway-sessions");
