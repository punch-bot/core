import { A2A_PROTOCOL_VERSION, type AgentCard, type AgentSkill } from "@a2a-js/sdk";

export interface CreatePunchAgentCardOptions {
	baseUrl: string;
	name?: string;
	description?: string;
	version?: string;
	skills?: readonly AgentSkill[];
}

export function createPunchAgentCard(options: CreatePunchAgentCardOptions): AgentCard {
	const normalizedBaseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;
	const skills: AgentSkill[] = options.skills
		? [...options.skills]
		: [
				{
					id: "coding_agent",
					name: "Coding Agent",
					description: "General-purpose coding agent with read, bash, edit, and write tools.",
					tags: ["coding", "agent"],
					examples: ["Fix the failing test in src/foo.test.ts", "Summarize this repository"],
					inputModes: ["text"],
					outputModes: ["text", "task-status"],
					securityRequirements: [],
				},
			];

	return {
		name: options.name ?? "Punch Agent",
		description: options.description ?? "A punch coding agent exposed over the Agent2Agent protocol.",
		supportedInterfaces: [
			{
				url: normalizedBaseUrl,
				protocolBinding: "JSONRPC",
				tenant: "",
				protocolVersion: A2A_PROTOCOL_VERSION,
			},
		],
		provider: {
			organization: "Punch",
			url: "https://github.com/punch-bot/core",
		},
		version: options.version ?? "1.0.0",
		capabilities: {
			streaming: true,
			pushNotifications: false,
			extensions: [],
			extendedAgentCard: false,
		},
		securitySchemes: {},
		securityRequirements: [],
		defaultInputModes: ["text"],
		defaultOutputModes: ["text", "task-status"],
		skills,
		documentationUrl: "https://github.com/punch-bot/core",
		signatures: [],
	};
}
