#!/usr/bin/env bash
set -euo pipefail

# Cloud Agent install for the punch (pi) monorepo.
#
# The repo requires Node >= 22.19.0 (see the root package.json "engines").
# Its TypeScript build and model-data generator scripts are invoked with a
# bare `node scripts/*.ts` and rely on Node's native type stripping
# (strip-only mode), which is only enabled by default on Node >= 22.18. On an
# older Node they fail with ERR_UNKNOWN_FILE_EXTENSION. Prefer the newest
# nvm-installed Node so this stays correct even if an older `node` is ahead on
# PATH.
node_bin="$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1 || true)"
if [ -n "${node_bin}" ] && [ -x "${node_bin}/node" ]; then
	export PATH="${node_bin}:${PATH}"
fi
echo "Using node $(node --version) ($(command -v node))"

# Install workspace dependencies. --ignore-scripts is repo policy: the packages
# do not need dependency lifecycle scripts for a normal install.
npm install --ignore-scripts

# Generate the provider model data the CLI needs at runtime. This directory
# (packages/ai/src/providers/data) is gitignored and produced from live
# provider catalogs, so it must be regenerated after checkout. Requires network
# egress to the provider catalog endpoints.
npm run hydrate:model-data
