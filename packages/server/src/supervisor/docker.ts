import { request } from "node:http";

export interface SandboxContainerSpec {
	readonly name: string;
	readonly image: string;
	readonly network: string;
	readonly volume: string;
	readonly labels: Readonly<Record<string, string>>;
	readonly environment: Readonly<Record<string, string>>;
	readonly memoryBytes: number;
	readonly nanoCpus: number;
}

export interface SandboxContainerState {
	readonly id: string;
	readonly running: boolean;
	readonly labels: Readonly<Record<string, string>>;
}

/** Only the supervisor receives the Docker socket. Runtime containers use private network connections. */
export class DockerEngine {
	readonly #socketPath: string;
	readonly #timeoutMs: number;
	constructor(options: { socketPath?: string; timeoutMs?: number } = {}) {
		this.#socketPath = options.socketPath ?? "/var/run/docker.sock";
		this.#timeoutMs = options.timeoutMs ?? 60_000;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) throw new Error("Invalid Docker timeout");
	}

	async #request(method: string, path: string, body?: unknown, allowMissing = false): Promise<unknown> {
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
		return new Promise((resolve, reject) => {
			const req = request(
				{
					socketPath: this.#socketPath,
					path: `/v1.45${path}`,
					method,
					headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
				},
				(response) => {
					const chunks: Buffer[] = [];
					let length = 0;
					response.on("error", reject);
					response.on("data", (chunk: Buffer) => {
						length += chunk.length;
						if (length > 1024 * 1024) {
							req.destroy(new Error("Docker response exceeds limit"));
							return;
						}
						chunks.push(chunk);
					});
					response.on("end", () => {
						const status = response.statusCode ?? 0;
						if (status === 404 && allowMissing) {
							resolve(undefined);
							return;
						}
						if (status < 200 || status >= 300) {
							reject(new Error(`Docker ${method} ${path} returned ${status}`));
							return;
						}
						try {
							resolve(length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
						} catch (error) {
							reject(new Error("Invalid Docker response", { cause: error }));
						}
					});
				},
			);
			const timer = setTimeout(() => req.destroy(new Error("Docker request timed out")), this.#timeoutMs);
			timer.unref();
			req.on("close", () => clearTimeout(timer));
			req.on("error", reject);
			req.end(payload);
		});
	}

	async inspect(name: string): Promise<SandboxContainerState | undefined> {
		const value = await this.#request("GET", `/containers/${encodeURIComponent(name)}/json`, undefined, true);
		if (value === undefined) return undefined;
		if (!value || typeof value !== "object") throw new Error("Invalid Docker container");
		const data = value as { Id?: unknown; State?: { Running?: unknown }; Config?: { Labels?: unknown } };
		const labels = data.Config?.Labels;
		if (
			typeof data.Id !== "string" ||
			typeof data.State?.Running !== "boolean" ||
			!labels ||
			typeof labels !== "object" ||
			Array.isArray(labels) ||
			Object.values(labels).some((value) => typeof value !== "string")
		)
			throw new Error("Invalid Docker container state");
		return { id: data.Id, running: data.State.Running, labels: labels as Record<string, string> };
	}

	async create(spec: SandboxContainerSpec): Promise<void> {
		if (!/^(?:sha256:|.+@sha256:)[a-f0-9]{64}$/.test(spec.image))
			throw new Error("Sandbox image must be pinned by digest");
		if (!spec.network || !spec.volume || !spec.name) throw new Error("Sandbox requires a name, network and volume");
		if (![spec.memoryBytes, spec.nanoCpus].every((value) => Number.isSafeInteger(value) && value > 0))
			throw new Error("Invalid sandbox resource limits");
		await this.#request("POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, {
			Image: spec.image,
			Env: Object.entries(spec.environment).map(([key, value]) => `${key}=${value}`),
			Labels: spec.labels,
			HostConfig: {
				NetworkMode: spec.network,
				Memory: spec.memoryBytes,
				NanoCpus: spec.nanoCpus,
				PidsLimit: 256,
				Init: true,
				CapDrop: ["ALL"],
				SecurityOpt: ["no-new-privileges"],
				RestartPolicy: { Name: "no" },
				Mounts: [{ Type: "volume", Source: spec.volume, Target: "/sandbox" }],
			},
		});
	}
	async start(name: string): Promise<void> {
		await this.#request("POST", `/containers/${encodeURIComponent(name)}/start`);
	}
	async stop(name: string, graceSeconds: number): Promise<void> {
		if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 0) throw new Error("Invalid stop grace period");
		await this.#request("POST", `/containers/${encodeURIComponent(name)}/stop?t=${graceSeconds}`);
	}
	/** Never force-remove a running writer or implicitly delete its volume. */
	async remove(name: string): Promise<void> {
		await this.#request("DELETE", `/containers/${encodeURIComponent(name)}`, undefined, true);
	}
	async ensureVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
		const value = await this.#request("GET", `/volumes/${encodeURIComponent(name)}`, undefined, true);
		if (value !== undefined) {
			if (
				!value ||
				typeof value !== "object" ||
				!("Labels" in value) ||
				!value.Labels ||
				typeof value.Labels !== "object" ||
				Object.entries(labels).some(([key, expected]) => Reflect.get(value.Labels as object, key) !== expected)
			)
				throw new Error("Sandbox volume ownership mismatch");
			return;
		}
		await this.#request("POST", "/volumes/create", { Name: name, Labels: labels });
	}
	async removeVolume(name: string): Promise<void> {
		await this.#request("DELETE", `/volumes/${encodeURIComponent(name)}`, undefined, true);
	}
}
