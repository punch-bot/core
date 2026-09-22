import * as durable from "@punch-bot/durable";
import * as environment from "@punch-bot/durable/env";
import * as jsonl from "@punch-bot/durable/storage/jsonl";
import * as sqlite from "@punch-bot/durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
