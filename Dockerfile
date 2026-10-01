# Single container: builds the frontend, then runs the gateway (which forks the 3 worker processes).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=8080
EXPOSE 8080
CMD ["npx", "tsx", "server/main.ts"]
