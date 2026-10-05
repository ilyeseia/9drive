set -e

: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD before running (never commit secrets)}"

PG_NAME=9drive-pg-dev
RD_NAME=9drive-redis-dev
PG_IMAGE=postgres:16-alpine
RD_IMAGE=redis:7-alpine

echo "=== pre-clean (idempotent recreate) ==="
docker rm -f "$PG_NAME" "$RD_NAME" 2>/dev/null || true

echo "=== volumes ==="
docker volume create 9drive_pg_data >/dev/null
docker volume create 9drive_redis_data >/dev/null

echo "=== pull images ==="
docker pull "$PG_IMAGE"
docker pull "$RD_IMAGE"

echo "=== run postgres ==="
docker run -d \
  --name "$PG_NAME" \
  --restart unless-stopped \
  -e POSTGRES_USER=9drive \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -e POSTGRES_DB=9drive \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -p 127.0.0.1:15432:5432 \
  -v 9drive_pg_data:/var/lib/postgresql/data \
  --memory=2g --cpus=1.0 \
  "$PG_IMAGE"

echo "=== run redis ==="
docker run -d \
  --name "$RD_NAME" \
  --restart unless-stopped \
  -p 127.0.0.1:16379:6379 \
  -v 9drive_redis_data:/data \
  --memory=768m \
  "$RD_IMAGE" \
  redis-server --appendonly yes --maxmemory 512mb --maxmemory-policy allkeys-lru

echo "=== wait for postgres ==="
for i in $(seq 1 30); do
  if docker exec "$PG_NAME" pg_isready -U 9drive -d 9drive >/dev/null 2>&1; then
    echo "postgres ready after ${i}s"
    break
  fi
  sleep 1
done

echo "=== status ==="
docker ps --filter "name=9drive" --format '{{.Names}}|{{.Status}}|{{.Image}}|{{.Ports}}'
echo "=== verify postgres ==="
docker exec "$PG_NAME" psql -U 9drive -d 9drive -tAc "select version();"
echo "=== verify redis ==="
docker exec "$RD_NAME" redis-cli ping
