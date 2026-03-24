FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production
RUN npm remove @shopify/cli

COPY . .

# Use the production Prisma schema (PostgreSQL)
RUN cp prisma/schema.prod.prisma prisma/schema.prisma

# Dummy DATABASE_URL for build-time prisma generate (not used at runtime)
ENV DATABASE_URL="postgresql://dummy:dummy@localhost:5432/dummy"

# Clear SQLite migrations and create fresh PostgreSQL baseline
RUN rm -rf prisma/migrations
RUN mkdir -p prisma/migrations/0_init
RUN npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0_init/migration.sql
RUN echo 'provider = "postgresql"' > prisma/migrations/migration_lock.toml

RUN npx prisma generate
RUN npm run build

# Clear dummy URL so runtime uses the real one from env
ENV DATABASE_URL=""

CMD ["npm", "run", "docker-start"]
