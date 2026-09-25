// Human-facing smoke test for the public API. Extend this after each package so
// design changes are exercised as ordinary application code, not only fixtures.
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import { type ConversationId, createSession, defineDoc, MemoryStorage, type Task } from "../src/index.ts";

const session = createSession(new MemoryStorage());

// Example 1: create an explicitly ownerless conversation.
// ID brands are erased, so the returned ConversationId is still a plain number.
const conversation = await session.commit(
	(tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
	BACKGROUND_CONTEXT,
);
console.log("ownerless conversation:", conversation);
console.log("conversation ID runtime type:", typeof conversation.id);

// Example 2: keep rewindable document state aligned with transcript entries.
// A historical read selects the document value committed with that entry.
const ConversationDoc = defineDoc<{ value: string }>({
	kind: "my-conversation-doc",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ value: "initial" }),
});

const firstEntryId = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(conversation.id, { kind: "first" });
	(await tx.doc(ConversationDoc, conversation.id)).value = "first value";
	return entry.id;
}, BACKGROUND_CONTEXT);

const secondEntryId = await session.commit(async (tx) => {
	const entry = await tx.appendEntry(conversation.id, { kind: "second" });
	(await tx.doc(ConversationDoc, conversation.id)).value = "second value";
	return entry.id;
}, BACKGROUND_CONTEXT);

console.log("current value:", await session.snapshot(ConversationDoc, conversation.id, BACKGROUND_CONTEXT));
console.log(
	"value at first entry:",
	await session.snapshotAsOf(ConversationDoc, conversation.id, firstEntryId, BACKGROUND_CONTEXT),
);
console.log(
	"value at second entry:",
	await session.snapshotAsOf(ConversationDoc, conversation.id, secondEntryId, BACKGROUND_CONTEXT),
);

// Example 3: atomically provision a background-owned fork and registry mapping.
// The task is the durable ownership boundary. The registry stores application
// lookup and request identities without duplicating task lifecycle state.
const AgentRegistry = defineDoc<{
	agents: Record<string, { conversationId: ConversationId; requestId: string }>;
}>({
	kind: "my-agent-registry",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {} }),
});

const SupervisorTask: Task<null, { phase: "ready" }, null, object> = {
	definition: {
		name: "my-supervisor",
		version: 1,
		initial: () => ({ phase: "ready" }),
	},
};

const provisioned = await session.commit(async (tx) => {
	const supervisorId = await tx.createTask(SupervisorTask, null, {
		conversationId: conversation.id,
		background: true,
	});
	const child = await tx.forkConversation(conversation.id, secondEntryId, {
		ownership: { kind: "task", taskId: supervisorId },
	});
	const registry = await tx.doc(AgentRegistry, conversation.id);
	registry.agents.researcher = {
		conversationId: child.id,
		requestId: `initial:${supervisorId}`,
	};
	return { supervisorId, child };
}, BACKGROUND_CONTEXT);

console.log("background supervisor ID:", provisioned.supervisorId);
console.log("owned child:", provisioned.child);
console.log("forked child value:", await session.snapshot(ConversationDoc, provisioned.child.id, BACKGROUND_CONTEXT));
console.log("parent registry:", await session.snapshot(AgentRegistry, conversation.id, BACKGROUND_CONTEXT));
// fork: initial leaves the child registry absent until its first typed transaction access.
console.log("child registry:", await session.snapshot(AgentRegistry, provisioned.child.id, BACKGROUND_CONTEXT));

await session.close(BACKGROUND_CONTEXT);
