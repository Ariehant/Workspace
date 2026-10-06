# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/server/Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
# Install only the server and the workspace packages it uses.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY apps/server apps/server
RUN pnpm install --frozen-lockfile --filter "@workspace/server..." --ignore-scripts
RUN pnpm --filter @workspace/server build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    FILES_DIR=/data/files
# The bundle has everything; no node_modules needed.
COPY --from=build /src/apps/server/dist ./dist
RUN mkdir -p /data/files && chown -R node:node /data \
 && printf '#!/bin/sh\nexec node /app/dist/admin.js "$@"\n' > /usr/local/bin/workspace-admin \
 && chmod +x /usr/local/bin/workspace-admin
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
