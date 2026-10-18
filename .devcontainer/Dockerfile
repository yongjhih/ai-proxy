FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# Ensure config directory exists for node user
RUN mkdir -p /home/node/.config/ai-proxy && chown -R node:node /home/node/.config
