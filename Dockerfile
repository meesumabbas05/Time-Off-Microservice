# Base image for building
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production image
FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
# SQLite database will be in /data/toms.db
RUN mkdir -p /data

EXPOSE 3000

ENV DATABASE_PATH=/data/toms.db

CMD ["node", "dist/main"]
