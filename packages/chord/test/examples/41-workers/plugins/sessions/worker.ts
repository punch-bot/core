// The sessions plugin's worker facet: each worker greets with its process id.

import { constant, defineFacet } from "@punch-bot/chord";
import { Greeting } from "./contract.ts";

export default defineFacet((host) =>
	host.serve(Greeting, ({ id }) => ({
		variant: "main",
		members: { text: constant(`hello from session ${id}`), pid: constant(process.pid) },
	})),
);
