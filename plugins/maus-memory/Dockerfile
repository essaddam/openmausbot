ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY sql ./sql
USER node
ENV MAUS_HOST=0.0.0.0 MAUS_PORT=8787
EXPOSE 8787
CMD ["node", "src/server.ts"]
