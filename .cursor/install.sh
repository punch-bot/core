#!/usr/bin/env bash
set -euo pipefail

# Cloud Agent install for the punch (pi) monorepo.
#
# The repo requires Node >= 22.19.0 (see the root package.json "engines").
# Its TypeScript build and model-data generator scripts are invoked with a
# bare `node scripts/*.ts` and rely on Node's native type stripping
# (strip-only mode), which is only enabled by default on Node >= 22.18. On an
# older Node they fail with ERR_UNKNOWN_FILE_EXTENSION.
required_major=22
required_minor=19

# Returns 0 when the given node binary reports a version >= the required one.
node_meets_min() {
	local version major rest minor
	version="$("$1" --version 2>/dev/null)" || return 1
	version="${version#v}"
	major="${version%%.*}"
	rest="${version#*.}"
	minor="${rest%%.*}"
	case "${major}" in "" | *[!0-9]*) return 1 ;; esac
	case "${minor}" in "" | *[!0-9]*) return 1 ;; esac
	if [ "${major}" -gt "${required_major}" ]; then return 0; fi
	[ "${major}" -eq "${required_major}" ] && [ "${minor}" -ge "${required_minor}" ]
}

# Pick a suitable Node, most preferred first: the newest nvm-installed Node (so
# a good Node is used even when an older one is ahead on PATH), then whatever
# `node` is already on PATH. Only a candidate that meets the minimum is chosen.
newest_nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
selected_node=""
for candidate in "${newest_nvm_bin:+${newest_nvm_bin}/node}" "$(command -v node || true)"; do
	[ -n "${candidate}" ] && [ -x "${candidate}" ] || continue
	if node_meets_min "${candidate}"; then
		selected_node="${candidate}"
		break
	fi
done

# Fail fast before installing anything, so the failure is an actionable message
# here rather than a cryptic ERR_UNKNOWN_FILE_EXTENSION from the bare-`node` .ts
# generators after a full (and wasted) npm install.
if [ -z "${selected_node}" ]; then
	active="$(node --version 2>/dev/null || echo "none")"
	echo "error: the pi monorepo requires Node >= ${required_major}.${required_minor}.0, but no suitable Node was found (active: ${active})." >&2
	echo "       Its model-data generators run bare '.ts' via native type stripping (Node >= 22.18)." >&2
	echo "       Install a suitable Node (e.g. 'nvm install 22') and re-run." >&2
	exit 1
fi

export PATH="$(dirname "${selected_node}"):${PATH}"
echo "Using node $(node --version) ($(command -v node))"

# Install workspace dependencies. --ignore-scripts is repo policy: the packages
# do not need dependency lifecycle scripts for a normal install.
npm install --ignore-scripts

# Generate the provider model data the CLI needs at runtime. This directory
# (packages/ai/src/providers/data) is gitignored and produced from live
# provider catalogs, so it must be regenerated after checkout. Requires network
# egress to the provider catalog endpoints.
npm run hydrate:model-data
