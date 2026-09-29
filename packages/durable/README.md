# @punch-bot/durable

Durable conversation, task, and document runtime for Pi.

This package contains the Pico runtime. Its current public API provides durable record contracts and memory, JSONL, and SQLite storage implementations:

```ts
import { MemoryStorage, ROOT_CONVERSATION_ID } from "@punch-bot/durable";
```

The root export is runtime-neutral. Storage implementations also have explicit subpaths:

```ts
import { MemoryStorage } from "@punch-bot/durable/storage/memory";
```

Node applications can open file-backed JSONL or SQLite storage through Node-only subpaths:

```ts
import { BACKGROUND_CONTEXT } from "@punch-bot/chord/context";
import { openNodeJsonlStorage } from "@punch-bot/durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@punch-bot/durable/storage/sqlite/node";

const jsonl = await openNodeJsonlStorage("./session", BACKGROUND_CONTEXT);
const sqlite = await openNodeSqliteStorage("./session.sqlite");
```

The portable JSONL core accepts the `FileSystem` capability exported from `@punch-bot/durable/env`. Its `fsync` option defaults to `false`; enabling it flushes affected sidecars before appending the main commit marker. One `JsonlStorage` owner must serialize writes to a storage directory; cross-process locking and ID allocation are not supported.

The portable SQLite core, minimal database facade, and ordered schema migrations are exported from `@punch-bot/durable/storage/sqlite`. Adapters for synchronous SQLite environments such as Bun and Cloudflare Durable Objects can implement that facade without importing Node APIs. Remote asynchronous APIs such as Cloudflare D1 cannot implement this synchronous facade; they require a dedicated `Storage` backend.

The Node adapter uses WAL mode with `synchronous = NORMAL` and checkpoints the WAL on close. Acknowledged commits survive process crashes, but the newest commits may be lost after a power or host failure. One `SqliteStorage` owner must serialize writes to a database file; cross-process ID allocation is not supported.

## Tools

`@punch-bot/durable/tools` provides `read`, `bash`, `edit`, and `write` tools. They reach files and processes only through the execution environment the Harness passes as `api.env` (`HarnessOptions.env`, or one a tool wrapper supplies). Reading images is not supported yet.

```ts
import { NodeExecutionEnv } from "@punch-bot/durable/env/node";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@punch-bot/durable/tools";

registry.batch(() => {
	for (const tool of [createReadTool(), createBashTool(), createEditTool(), createWriteTool()]) registry.tools.add(tool);
});
const harness = await Harness.open(storage, { models, registry, env: new NodeExecutionEnv({ cwd }) }, context);
```

The package root loads TypeBox, because the built-in tool task validates tool arguments with pi-ai's `validateToolArguments()`. Unbundled, that costs about 23 MB of peak RSS; a tree-shaken bundle keeps about 4 MB.

`npm run bench:tool-output` drives the tool task and its throttled `pi.live` progress commits at low, normal, and high output rates, with head and tail retention, one and four parallel tools, and all three backends. It reports commits, operation bytes, whole-window output writes, commit latency, stored size mid-round and after the round, replay time on reopen, peak RSS, and heap, plus 1 GiB throughput through `api.output()` and through the bash tool.

## Storage conformance

Storage adapters can register the runner-independent conformance cases through the testing entry. The convenience adapter accepts Vitest/Jest-compatible runner functions without importing either package:

```ts
import { registerStorageConformance } from "@punch-bot/durable/testing";
import { describe, expect, it } from "vitest";

registerStorageConformance({ describe, expect, it }, "Some Custom Storage", async (use) => {
	const storage = await openCustomStorage();
	try {
		await use(storage);
	} finally {
		await closeStorage(storage);
	}
});
```

The provider must call and await `use` exactly once with isolated storage. Other runners can use `createStorageConformance` with their own `StorageConformanceAssertions` implementation.

## Storage benchmarks

From this package directory:

```sh
npm run bench:storage
npm run bench:storage:memory
```

The timing suite runs shared deterministic workloads against the built-in memory, JSONL, and SQLite adapters. Third-party adapters can import the same seeds and workload definitions from `@punch-bot/durable/testing` and use their platform's timing runner:

```ts
import {
	seedStorageBenchmark,
	seedStorageWriteBenchmark,
	STORAGE_READ_BENCHMARKS,
	STORAGE_WRITE_BENCHMARKS,
} from "@punch-bot/durable/testing";

const dataset = await seedStorageBenchmark(readStorage);
await STORAGE_READ_BENCHMARKS[0].run(readStorage, dataset);

await seedStorageWriteBenchmark(freshWriteStorage);
await STORAGE_WRITE_BENCHMARKS[0].run(freshWriteStorage);
```

Read scenarios reuse one seeded store; each write sample requires a fresh seeded store. The workloads cover representative commits, indexed reads, pagination, fork traversal, document replay, historical reads, and persistent-backend reopen. The footprint suite measures each built-in adapter in a separate process at 1k and 10k scales and reports heap, RSS, external memory, file counts, and on-disk JSONL/SQLite size. These synthetic workloads are baselines for regression analysis, not production capacity limits or CI pass/fail thresholds.

The normative design and implementation sequence are in:

- [`docs/pico-v5.md`](docs/pico-v5.md)
- [`docs/pico-v5-handoff.md`](docs/pico-v5-handoff.md)
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md)
