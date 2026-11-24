#!/usr/bin/env bash
set -euo pipefail

source_file="/var/lib/chensi-ai-content-os/runtime-data/store.json"
backup_root="/var/backups/chensi-ai-content-os"
retention_days="${CHENSI_BACKUP_RETENTION_DAYS:-14}"
app_env="/etc/chensi-ai-content-os/app.env"

if [[ -r "$app_env" ]]; then
  set -a
  # The environment file is only sourced locally; no credentials are printed.
  . "$app_env"
  set +a
fi

umask 077
if [[ ! -s "$source_file" ]]; then
  echo "store file is missing or empty: $source_file" >&2
  exit 1
fi

install -d -m 700 "$backup_root"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$backup_root/store-$timestamp.json"
temporary="$destination.tmp"
cp --reflink=auto -- "$source_file" "$temporary"
mv -f -- "$temporary" "$destination"
sha256sum -- "$destination" > "$destination.sha256"

if [[ "${IP_AGENT_STORE_DRIVER:-json}" == "postgres" || "${IP_AGENT_STORE_DRIVER:-json}" == "postgresql" ]]; then
  postgres_url="${IP_AGENT_POSTGRES_URL:-}"
  if [[ -z "$postgres_url" ]]; then
    echo "IP_AGENT_POSTGRES_URL is missing while PostgreSQL store is enabled" >&2
    exit 1
  fi
  dump_destination="$backup_root/postgres-$timestamp.dump"
  dump_temporary="$(mktemp /tmp/chensi-postgres-dump.XXXXXX)"
  trap 'rm -f -- "$dump_temporary"' EXIT
  runuser -u chensi -- pg_dump --format=custom --no-owner "$postgres_url" > "$dump_temporary"
  mv -f -- "$dump_temporary" "$dump_destination"
  sha256sum -- "$dump_destination" > "$dump_destination.sha256"
fi

find "$backup_root" -type f -name 'store-*.json' -mtime "+$retention_days" -delete
find "$backup_root" -type f -name 'store-*.json.sha256' -mtime "+$retention_days" -delete
find "$backup_root" -type f -name 'postgres-*.dump' -mtime "+$retention_days" -delete
find "$backup_root" -type f -name 'postgres-*.dump.sha256' -mtime "+$retention_days" -delete
echo "backup created: $destination"
