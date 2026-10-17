FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/app/data HOST=0.0.0.0 PORT=8790
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8790
CMD ["node", "--import", "tsx", "src/index.ts"]
