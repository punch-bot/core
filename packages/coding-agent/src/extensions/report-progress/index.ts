import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";

const limits = { goal: 200, finding: 300, next: 200 } as const;

export default function reportProgressExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "report_progress",
		label: "Report progress",
		description:
			"Publish a brief, user-visible milestone. This is not a scratchpad: include only conclusions and intended actions safe to show the user.",
		promptSnippet: "Share a meaningful public progress milestone",
		promptGuidelines: [
			"Use only for meaningful user-visible milestones, never hidden reasoning, chain-of-thought, credentials, or raw tool data.",
		],
		parameters: Type.Object(
			{
				goal: Type.Optional(
					Type.String({ maxLength: limits.goal, description: "Public description of the current goal" }),
				),
				finding: Type.Optional(
					Type.String({ maxLength: limits.finding, description: "Public conclusion or key discovery" }),
				),
				next: Type.Optional(
					Type.String({ maxLength: limits.next, description: "Public description of the next action" }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, args) {
			if (!args.goal && !args.finding && !args.next) {
				throw new Error("goal, finding, or next is required");
			}
			return { content: [{ type: "text" as const, text: "Progress milestone shared." }], details: {} };
		},
	});
}
