# Unraid Deployment

## Prerequisites

- Docker Desktop with `buildx` (macOS default)
- SSH access to Unraid (`root@<UNRAID_IP>`)

## First-Time Setup

### 1. Build for x86_64

```bash
docker buildx build --platform linux/amd64 -t dispatch . --load
```

### 2. Transfer to Unraid

```bash
docker save dispatch | gzip > /tmp/dispatch.tar.gz
scp /tmp/dispatch.tar.gz root@<UNRAID_IP>:/mnt/user/appdata/dispatch/
```

### 3. Start on Unraid

```bash
ssh root@<UNRAID_IP>

docker load < /mnt/user/appdata/dispatch/dispatch.tar.gz

# Start Postgres
docker run -d \
  --name dispatch-db \
  -v /mnt/user/appdata/dispatch/pgdata:/var/lib/postgresql/data \
  -e POSTGRES_DB=sprint_tracker \
  -e POSTGRES_USER=sprint \
  -e POSTGRES_PASSWORD=sprint \
  --restart unless-stopped \
  postgres:17-alpine

# Start app (wait a few seconds for Postgres to be ready)
docker run -d \
  --name dispatch \
  -p 3888:3001 \
  -e DATABASE_URL=postgres://sprint:sprint@dispatch-db:5432/sprint_tracker \
  --link dispatch-db:db \
  --restart unless-stopped \
  dispatch
```

Note: The `--link` flag maps `dispatch-db` to hostname `db` inside the app container. Update `DATABASE_URL` host accordingly if using Docker networks instead.

### 4. Register MCP in Claude Code

```bash
claude mcp add -s user -t http dispatch http://<UNRAID_IP>:3888/mcp
```

## Updating After Code Changes

### 1. Build and transfer

```bash
docker buildx build --platform linux/amd64 -t dispatch . --load
docker save dispatch | gzip > /tmp/dispatch.tar.gz
scp /tmp/dispatch.tar.gz root@<UNRAID_IP>:/mnt/user/appdata/dispatch/
```

### 2. Replace on Unraid

```bash
ssh root@<UNRAID_IP>

docker stop dispatch && docker rm dispatch
docker load < /mnt/user/appdata/dispatch/dispatch.tar.gz
docker run -d \
  --name dispatch \
  -p 3888:3001 \
  -e DATABASE_URL=postgres://sprint:sprint@dispatch-db:5432/sprint_tracker \
  --link dispatch-db:db \
  --restart unless-stopped \
  dispatch
```

Postgres container stays running — data persists across app updates.

## Endpoints

| Service | URL |
|---------|-----|
| MCP | http://<UNRAID_IP>:3888/mcp |
| Health | http://<UNRAID_IP>:3888/health |
