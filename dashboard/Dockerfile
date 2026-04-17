FROM node:22-bookworm-slim AS builder

WORKDIR /app/dashboard

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

COPY apps ./apps
COPY packages ./packages
COPY README.md ./README.md

RUN npm run build


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

WORKDIR /app/dashboard

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dashboard/apps/server/dist ./apps/server/dist
COPY --from=builder /app/dashboard/apps/web/dist ./apps/web/dist
COPY --from=builder /app/dashboard/packages/shared/dist ./packages/shared/dist

USER node
EXPOSE 8080

CMD ["node", "apps/server/dist/index.js"]
