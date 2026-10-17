FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/app/data PORT=8787
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/index.ts"]
