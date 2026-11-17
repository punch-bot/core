// The audit plugin: no routes of its own, one wrap around every route (`scope: "all"`), outermost (`observe`).

import { defineFacet } from "@punch-bot/chord";
import { Http } from "@punch-bot/chord/http";

export default defineFacet((_host, self) =>
	self.contribute(Http, {
		wraps: [
			{
				name: "log",
				phase: "observe",
				scope: "all",
				wrap: async (request, next, ctx) => {
					const response = await next(request);
					const status = "status" in response ? response.status : 200;
					console.log(
						`   audit: ${ctx.principal === undefined ? "anonymous" : "someone"} ${request.method} ${request.path} ${status}`,
					);
					return response;
				},
			},
		],
	}),
);
