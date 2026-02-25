FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm

COPY package.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/
COPY src ./src/

RUN pnpm install
RUN pnpm exec prisma generate
RUN pnpm exec tsc

FROM node:20-alpine

WORKDIR /app

RUN npm install -g pnpm

COPY package.json ./
COPY prisma ./prisma/

RUN pnpm install --prod
RUN pnpm exec prisma generate

COPY --from=builder /app/dist ./dist

EXPOSE 4000

CMD ["node", "dist/server.js"]
