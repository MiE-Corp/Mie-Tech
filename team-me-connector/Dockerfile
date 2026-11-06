FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_FILE=/data/team-me.json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
