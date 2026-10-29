#!/usr/bin/env bash
# Print repository file paths containing an API path or Mini App action ID.
set -u

if [[ $# -ne 1 || -z "$1" ]]; then
  printf 'Usage: %s <route-or-action>\n' "${0##*/}" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
status=0
rg --color never --fixed-strings --files-with-matches --hidden \
  --glob '!.git/**' --glob '!node_modules/**' --glob '!coverage/**' \
  -- "$1" "$repo_root/api" "$repo_root/bot" "$repo_root/miniapp" "$repo_root/docs" || status=$?

case "$status" in
  0) ;;
  1) printf 'No matching files for: %s\n' "$1" ;;
  *) printf 'Search failed (rg exit %s).\n' "$status" >&2; exit "$status" ;;
esac
