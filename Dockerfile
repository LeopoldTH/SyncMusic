# Etape de build: dependances completes, construction du client.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Etape d'execution: dependances de production seulement.
# Le serveur tourne via tsx (dependance de production), pas de compilation prealable.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared

EXPOSE 8787
CMD ["./node_modules/.bin/tsx", "server/index.ts"]
