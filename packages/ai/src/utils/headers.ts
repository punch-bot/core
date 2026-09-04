import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

export function providerHeadersToRecord(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== null) result[key] = value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

/** Case-insensitive merge of header sources; later sources override earlier ones by lowercased name. */
export function mergeHeaderSets(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders | undefined {
	const defined = sources.filter((source) => source !== undefined);
	if (defined.length === 0) return undefined;
	const merged: ProviderHeaders = {};
	const byLowerName = new Map<string, string>();
	for (const source of defined) {
		for (const [name, value] of Object.entries(source ?? {})) {
			const lowerName = name.toLowerCase();
			const priorName = byLowerName.get(lowerName);
			if (priorName !== undefined) delete merged[priorName];
			merged[name] = value;
			byLowerName.set(lowerName, name);
		}
	}
	return merged;
}
