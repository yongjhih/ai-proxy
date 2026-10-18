#!/usr/bin/env sh
set -eu

REPO_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p "${AI_PROXY_HOME:-$HOME/.config/ai-proxy}"

if [ -w /usr/local/bin ]; then
  ln -sf "${REPO_ROOT}/bin/ai-proxy.mjs" /usr/local/bin/ai-proxy
  ln -sf "${REPO_ROOT}/bin/ai-proxy-docker.mjs" /usr/local/bin/ai-proxy-docker
  ln -sf "${REPO_ROOT}/bin/ai-proxy-docker.mjs" /usr/local/bin/docker-wrapper
elif command -v sudo >/dev/null 2>&1; then
  sudo ln -sf "${REPO_ROOT}/bin/ai-proxy.mjs" /usr/local/bin/ai-proxy
  sudo ln -sf "${REPO_ROOT}/bin/ai-proxy-docker.mjs" /usr/local/bin/ai-proxy-docker
  sudo ln -sf "${REPO_ROOT}/bin/ai-proxy-docker.mjs" /usr/local/bin/docker-wrapper
fi

node --version
node "${REPO_ROOT}/bin/ai-proxy.mjs" --help >/dev/null
node "${REPO_ROOT}/bin/ai-proxy-docker.mjs" --help >/dev/null
