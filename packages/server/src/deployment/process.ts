export function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

/** Exit after a bounded drain even if an external connection stops responding. */
export function installShutdown(close: () => Promise<void>, timeoutMs: number): void {
	let closing = false;
	const stop = (): void => {
		if (closing) return;
		closing = true;
		const deadline = setTimeout(() => process.exit(1), timeoutMs);
		deadline.unref();
		void close().then(
			() => {
				clearTimeout(deadline);
			},
			(error) => {
				console.error(error);
				process.exitCode = 1;
			},
		);
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
}
