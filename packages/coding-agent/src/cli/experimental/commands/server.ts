import type { AuthInput } from "../auth.ts";
import { Command, valueOption } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
	unsupportedLegacyOptions,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";
import { type HttpTransportAddress, parseHttpListenAddress } from "../transport-address.ts";

export interface ServerCommand {
	readonly command: "server";
	readonly auth?: AuthInput;
	readonly listen?: readonly TransportAddress[];
	readonly a2aListen?: HttpTransportAddress;
}

export interface ServerCommandContext {
	runServer(command: ServerCommand): void | Promise<void>;
}

const listenOption = transportOption("--listen");
const a2aListenOption = valueOption("--a2a-listen", (value) => {
	const result = parseHttpListenAddress(value);
	return result.address
		? { ok: true, value: result.address }
		: { ok: false, error: result.error ?? `Invalid --a2a-listen address "${value}"` };
});

export const serverCommand = new Command<ServerCommand, ServerCommandContext>("server")
	.option(listenOption)
	.option(a2aListenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const a2aListen = input.value(a2aListenOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("server", input)];
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "server",
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
				...(a2aListen === undefined ? {} : { a2aListen }),
			},
		};
	})
	.action((command, context) => context.runServer(command));
