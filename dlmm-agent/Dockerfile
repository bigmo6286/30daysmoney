FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/app/data
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
