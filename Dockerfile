FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web
COPY site ./site
COPY docs ./docs
COPY skills ./skills
COPY index.html zh-TW.html doc.html dashboard.html mcp.html ./

ENV AI_PROXY_HOME=/data/ai-proxy
ENV AI_PROXY_NO_BROWSER=1
VOLUME ["/data/ai-proxy"]
EXPOSE 8788

ENTRYPOINT ["node", "/app/bin/ai-proxy.mjs"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8788"]
