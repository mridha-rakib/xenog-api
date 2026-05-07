# Spark Tech Backend

Express.js + TypeScript backend scaffold with module based architecture, repository layer, MongoDB/Mongoose, Redis, MinIO, structured logging, validation, and Docker infra.

## Stack

- Express.js
- TypeScript
- MongoDB + Mongoose
- Redis via `ioredis`
- MinIO via S3-compatible AWS SDK
- Pino structured logger
- Zod validation
- Helmet, CORS, compression, rate limit
- Docker Compose for free local infra

## Quick Start

```bash
npm install
cp .env.example .env
npm run docker:up
npm run dev
```

API base URL:

```text
http://localhost:5000/api/v1
```

MinIO console:

```text
http://localhost:9001
```

Default MinIO login:

```text
minioadmin / minioadmin
```

## Architecture

```text
src
  config        environment, database, redis, minio clients
  core          logger, errors, response helpers, middleware
  modules       feature modules
  routes        route aggregator
```

Each business feature should follow this pattern:

```text
feature.model.ts
feature.repository.ts
feature.service.ts
feature.controller.ts
feature.route.ts
feature.validation.ts
```

Controller handles HTTP, service handles business logic, repository handles database queries.
