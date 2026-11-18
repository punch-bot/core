/** Match provider IDs and display names exactly, ignoring case and surrounding whitespace in the reference. */
export function findMatchingProviders<T extends { id: string; name: string }>(
	providers: readonly T[],
	providerRef: string,
): T[] {
	const normalized = providerRef.trim().toLowerCase();
	if (!normalized) return [];
	return providers.filter(
		(provider) => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
	);
}

/** The provider a reference names: an exact ID match before a display-name match, so a display name cannot shadow an ID. */
export function findProvider<T extends { id: string; name: string }>(
	providers: readonly T[],
	providerRef: string,
): T | undefined {
	const matches = findMatchingProviders(providers, providerRef);
	const normalized = providerRef.trim().toLowerCase();
	return matches.find((provider) => provider.id.toLowerCase() === normalized) ?? matches[0];
}
