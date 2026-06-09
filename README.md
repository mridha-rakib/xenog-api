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
http://localhost:4000/api/v1
```

MinIO console:

```text
http://localhost:9001
```

Default MinIO login:

```text
minioadmin / minioadmin
```

## Docker Compose Services

Make sure Docker Desktop is running, then open a terminal in this folder:

```bash
cd xenog-api
```

Start all local infrastructure services:

```bash
docker compose up -d
```

Start only Redis and MinIO:

```bash
docker compose up -d redis minio
```

Check running containers:

```bash
docker compose ps
```

View logs:

```bash
docker compose logs -f
```

Stop all services:

```bash
docker compose down
```

Service URLs and ports:

```text
MongoDB: localhost:27017
Redis: localhost:6380
MinIO API: http://localhost:9000
MinIO Console: http://localhost:9001
```

Default MinIO login:

```text
Username: minioadmin
Password: minioadmin
```

If `.env` contains `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, or `REDIS_PASSWORD`, those values will be used instead of the defaults.

## Admin Seed

The backend automatically seeds an admin user when the server starts. Set these values in `.env`:

```text
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-strong-password
ADMIN_DISPLAY_NAME=Xenog Admin
```

Then start the API:

```bash
npm run dev
```

You can also seed only the admin account without starting the API:

```bash
npm run seed:admin
```

If the admin email does not exist, the app creates it. If the email already exists, the app updates that account with the `.env` display name and password, then ensures it is active, email verified, and `admin`.

Admin login endpoint:

```text
POST /api/v1/auth/admin/login
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

## Validation Error Format

Zod validation errors return a consistent field-wise shape:

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Validation failed",
  "details": {
    "issues": [
      {
        "path": "body.email",
        "field": "email",
        "location": "body",
        "message": "Invalid email",
        "code": "invalid_string"
      }
    ],
    "fields": {
      "body.email": ["Invalid email"]
    }
  }
}
```
