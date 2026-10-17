/**
 * Suffix variants: `<catalog id>:<suffix>` IDs that the catalog does not list, such as OpenRouter's routing
 * variants (`:nitro`, `:floor`). Providers accept these on a catalog model, so the variant keeps its base
 * model's metadata and sends the full ID. Catalog IDs that contain colons (`:free`, `:batch`) resolve as
 * themselves.
 */

import type { Api, Model } from "@punch-bot/ai";
import { isValidThinkingLevel } from "../cli/args.ts";

/**
 * Look up `modelId`, otherwise the longest `:`-separated prefix of it that `lookup` finds, copied under the
 * full ID. A thinking level (`:high`) is never a variant suffix, so a misplaced one is not sent to the provider
 * as part of the ID. `lookup` must only search one provider.
 */
export function findModelOrSuffixVariant(
	modelId: string,
	lookup: (id: string) => Model<Api> | undefined,
): Model<Api> | undefined {
	const exact = lookup(modelId);
	if (exact) return exact;
	for (let colon = modelId.lastIndexOf(":"); colon > 0; colon = modelId.lastIndexOf(":", colon - 1)) {
		const suffix = modelId.slice(colon + 1);
		if (suffix.split(":").some((part) => !part || isValidThinkingLevel(part))) return undefined;
		const base = lookup(modelId.slice(0, colon));
		if (base) return { ...base, id: modelId, name: `${base.name} (${suffix})` };
	}
	return undefined;
}
