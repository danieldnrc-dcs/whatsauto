FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY sql ./sql
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data/media && chown -R node:node /app/data
USER node
ENV NODE_ENV=production MEDIA_DIR=/app/data/media
EXPOSE 3000
# The same image runs the api (default) and the worker (command: node src/worker.ts).
CMD ["node", "src/api.ts"]
