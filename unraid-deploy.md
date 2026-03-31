# Unraid Deployment

## Prerequisites

- Docker Desktop with `buildx` (macOS default)
- SSH access to Unraid (`root@<UNRAID_IP>`)

## First-Time Setup

### 1. Build for x86_64

```bash
docker buildx build --platform linux/amd64 -t sprint-tracker . --load
```

### 2. Transfer to Unraid

```bash
docker save sprint-tracker | gzip > /tmp/sprint-tracker.tar.gz
scp /tmp/sprint-tracker.tar.gz root@<UNRAID_IP>:/mnt/user/appdata/sprint-tracker/
```

### 3. Start on Unraid

```bash
ssh root@<UNRAID_IP>

docker load < /mnt/user/appdata/sprint-tracker/sprint-tracker.tar.gz

# Start Postgres
docker run -d \
  --name sprint-tracker-db \
  -v /mnt/user/appdata/sprint-tracker/pgdata:/var/lib/postgresql/data \
  -e POSTGRES_DB=sprint_tracker \
  -e POSTGRES_USER=sprint \
  -e POSTGRES_PASSWORD=sprint \
  --restart unless-stopped \
  postgres:17-alpine

# Start app (wait a few seconds for Postgres to be ready)
docker run -d \
  --name sprint-tracker \
  -p 3888:3001 \
  -e DATABASE_URL=postgres://sprint:sprint@sprint-tracker-db:5432/sprint_tracker \
  --link sprint-tracker-db:db \
  --restart unless-stopped \
  sprint-tracker
```

Note: The `--link` flag maps `sprint-tracker-db` to hostname `db` inside the app container. Update `DATABASE_URL` host accordingly if using Docker networks instead.

### 4. Register MCP in Claude Code

```bash
claude mcp add -s user -t http sprint-tracker http://<UNRAID_IP>:3888/mcp
```

## Updating After Code Changes

### 1. Build and transfer

```bash
docker buildx build --platform linux/amd64 -t sprint-tracker . --load
docker save sprint-tracker | gzip > /tmp/sprint-tracker.tar.gz
scp /tmp/sprint-tracker.tar.gz root@<UNRAID_IP>:/mnt/user/appdata/sprint-tracker/
```

### 2. Replace on Unraid

```bash
ssh root@<UNRAID_IP>

docker stop sprint-tracker && docker rm sprint-tracker
docker load < /mnt/user/appdata/sprint-tracker/sprint-tracker.tar.gz
docker run -d \
  --name sprint-tracker \
  -p 3888:3001 \
  -e DATABASE_URL=postgres://sprint:sprint@sprint-tracker-db:5432/sprint_tracker \
  --link sprint-tracker-db:db \
  --restart unless-stopped \
  sprint-tracker
```

Postgres container stays running — data persists across app updates.

## Endpoints

| Service | URL |
|---------|-----|
| MCP | http://<UNRAID_IP>:3888/mcp |
| Health | http://<UNRAID_IP>:3888/health |
