import { readFileSync } from "node:fs";
import { createServer } from "node:https";

createServer(
	{ key: readFileSync("/fixture/key.pem"), cert: readFileSync("/fixture/cert.pem") },
	(request, response) => {
		if (request.url !== "/jwks") {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "content-type": "application/json" }).end(readFileSync("/fixture/jwks.json"));
	},
).listen(443, "0.0.0.0");
