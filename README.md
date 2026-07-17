# 🚀 HitBox Backend

A scalable backend for **HitBox Collectibles**, built using a **Hybrid Modular Monolith Architecture** with **Node.js**, **Express**, **TypeScript**, **PNPM Workspaces**, **TurboRepo**, and **Prisma**.

The project is designed to support millions of users while providing a clear migration path to a distributed microservices architecture.

---

# Architecture

HitBox follows a **Hybrid Modular Monolith** architecture.

- Single Backend Application
- Single PostgreSQL Database
- Single Prisma Client
- Domain-Driven Design (DDD)
- Feature-Based Modules
- Hybrid Prisma Schema
- Future Microservice Ready

Each business domain is isolated into its own package, making it easy to maintain today and extract into an independent microservice in the future.

---

# Tech Stack

## Backend

- Node.js
- Express.js
- TypeScript

## Database

- PostgreSQL (Neon)
- Prisma ORM

## Monorepo

- PNPM Workspaces
- TurboRepo

## Validation

- Zod

## Logging

- Pino

## Authentication

- Clerk

## Storage

- AWS S3

---

# Repository Structure

```text
hitbox/
│
├── apps/
│   └── backend/
│
├── packages/
│   ├── auth/
│   ├── users/
│   ├── products/
│   ├── marketplace/
│   ├── claims/
│   ├── orders/
│   ├── payments/
│   ├── notifications/
│   └── shared/
│
├── scripts/
│
├── docs/
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

---

# Package Overview

| Package | Responsibility |
|----------|----------------|
| auth | Authentication & Authorization |
| users | User Management |
| products | Product Management |
| discover | Discover feed (read-side product cards) |
| marketplace | Marketplace Operations |
| claims | Product Claims |
| orders | Orders & Checkout |
| payments | Payment Processing |
| notifications | Notifications & Messaging |
| shared | Shared Infrastructure |

---

# Prisma Architecture

Instead of maintaining one large Prisma schema, every domain owns its own Prisma schema file.

```text
packages/

auth/
└── prisma/
    └── auth.prisma

users/
└── prisma/
    └── users.prisma

products/
└── prisma/
    └── products.prisma

marketplace/
└── prisma/
    └── marketplace.prisma

claims/
└── prisma/
    └── claims.prisma

orders/
└── prisma/
    └── orders.prisma

payments/
└── prisma/
    └── payments.prisma

notifications/
└── prisma/
    └── notifications.prisma

shared/
└── database/
    └── prisma/
        ├── datasource.prisma
        ├── enums.prisma
        ├── schema.prisma      # Generated (Do Not Edit)
        └── migrations/
```

The final `schema.prisma` is automatically generated from all module schema files.

Developers should **never edit** `schema.prisma` directly.

---

# Getting Started

## Clone Repository

```bash
git clone <repository-url>
cd hitbox
```

## Install Dependencies

```bash
pnpm install
```

## Environment Variables

Create a single `.env` at the repository root (see [docs/getting-started.md](docs/getting-started.md) for the full list):

```dotenv
PORT=8080
NODE_ENV=development
DATABASE_URL=...            # Neon pooled URL
DIRECT_URL=...              # Neon direct (unpooled) URL — used by migrations
CLERK_SECRET_KEY=...
CLERK_WEBHOOK_SIGNING_SECRET=...
```

---

# Development

Run the backend only:

```bash
pnpm --filter backend dev
```

Run all applications (TurboRepo):

```bash
pnpm dev
```

---

# Build

Build the entire workspace:

```bash
pnpm build
```

Build only the backend:

```bash
pnpm --filter backend build
```

---

# Production

```bash
pnpm --filter backend start
```

---

# Useful PNPM Commands

## Install a dependency for the backend

```bash
pnpm --filter backend add express
```

## Install a dependency for a module

```bash
pnpm --filter @hitbox/products add zod
```

## Install a root development dependency

```bash
pnpm add -Dw eslint
```

## Run a command inside a module

```bash
pnpm --filter @hitbox/products lint
```

---

# Development Principles

- Domain-Driven Design (DDD)
- Modular Monolith Architecture
- Repository Pattern
- Service Layer
- Feature-Based Modules
- Dependency Injection
- Event-Driven Architecture
- Shared Infrastructure
- Strict TypeScript
- Scalable Folder Structure
- Future Microservice Ready

---

# Roadmap

### Current Architecture

```text
Monorepo
     │
     ▼
One Backend
     │
     ▼
One PostgreSQL Database
     │
     ▼
Hybrid Prisma Architecture
```

### Future Architecture

```text
API Gateway
│
├── User Service
├── Product Service
├── Marketplace Service
├── Order Service
├── Payment Service
├── Notification Service
└── Claim Service
```

Each service will own:

- Source Code
- Database
- Prisma Schema
- Prisma Client
- Docker Image
- CI/CD Pipeline
- Independent Deployment

---

# Documentation

Documentation lives in the [`docs/`](docs/) directory:

| Document | Contents |
|---|---|
| [Getting Started](docs/getting-started.md) | Setup, environment, database workflow, Clerk webhook wiring, troubleshooting |
| [Architecture](docs/hitbox-architecture.md) | Module anatomy, composition root, ports & events, hybrid Prisma pipeline, request lifecycle, adding a module, microservice extraction path |
| [API Reference](docs/api-reference.md) | Every endpoint with parameters, request/response shapes, and error codes |

---

# License

This repository is proprietary and intended for the HitBox Collectibles platform.