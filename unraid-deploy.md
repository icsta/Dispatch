# Unraid Deployment

## Prerequisites

- SSH access to Unraid (`root@<UNRAID_IP>`)

## First-Time Setup

### 1. Pull the image

```bash
ssh root@<UNRAID_IP>

docker pull ghcr.io/icsta/dispatch:latest
```

### 2. Start the containers

#### 2.1 No existing Postgres

```bash
# Start Postgres
docker run -d \
  --name dispatch-db \
  -v /mnt/user/appdata/dispatch/pgdata:/var/lib/postgresql/data \
  -e POSTGRES_DB=dispatch \
  -e POSTGRES_USER=dispatch \
  -e POSTGRES_PASSWORD=dispatch \
  --restart unless-stopped \
  postgres:17-alpine

# Start app (wait a few seconds for Postgres to be ready)
docker run -d \
  --name dispatch \
  -p 3888:3001 \
  -e DATABASE_URL=postgres://dispatch:dispatch@dispatch-db:5432/dispatch \
  --link dispatch-db:db \
  --restart unless-stopped \
  ghcr.io/icsta/dispatch:latest
```

Note: The `--link` flag maps `dispatch-db` to hostname `db` inside the app container. Update `DATABASE_URL` host accordingly if using Docker networks instead.

#### 2.2 Existing Postgres

If you already have a Postgres instance running, create a user and database for Dispatch:

```sql
CREATE USER dispatch WITH PASSWORD 'your_password';
CREATE DATABASE dispatch OWNER dispatch;
```

Then start the app pointing at your existing instance:

```bash
docker run -d \
  --name dispatch \
  -p 3888:3001 \
  -e DATABASE_URL=postgres://dispatch:your_password@<POSTGRES_HOST>:5432/dispatch \
  --restart unless-stopped \
  ghcr.io/icsta/dispatch:latest
```

The schema is applied automatically on first boot.

### 3. Register MCP in Claude Code

```bash
claude mcp add -s user -t http dispatch http://<UNRAID_IP>:3888/mcp
```

## Updating

```bash
ssh root@<UNRAID_IP>

docker pull ghcr.io/icsta/dispatch:latest
docker stop dispatch && docker rm dispatch
docker run -d \
  --name dispatch \
  -p 3888:3001 \
  -e DATABASE_URL=postgres://dispatch:dispatch@dispatch-db:5432/dispatch \
  --link dispatch-db:db \
  --restart unless-stopped \
  ghcr.io/icsta/dispatch:latest
```

Postgres container stays running — data persists across app updates.

## Building from Source

If you prefer to build locally instead of pulling from GHCR:

```bash
# On your Mac (builds for x86_64)
docker buildx build --platform linux/amd64 --no-cache -t dispatch . --load
docker save dispatch | gzip > /tmp/dispatch.tar.gz
scp /tmp/dispatch.tar.gz root@<UNRAID_IP>:/mnt/user/appdata/dispatch/

# On Unraid
docker load < /mnt/user/appdata/dispatch/dispatch.tar.gz
```

Then use `dispatch` instead of `ghcr.io/icsta/dispatch:latest` in the run commands above.

## Endpoints

| Service | URL |
|---------|-----|
| MCP | http://<UNRAID_IP>:3888/mcp |
| Health | http://<UNRAID_IP>:3888/health |
