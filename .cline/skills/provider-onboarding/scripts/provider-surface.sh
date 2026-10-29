#!/usr/bin/env bash
# Print repository file paths containing a provider name; never print file contents.
set -u

if [[ $# -ne 1 || -z "$1" ]]; then
  printf 'Usage: %s <provider-name>\n' "${0##*/}" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
needle="$1"
roots=()
for path in api bot miniapp docs .clinerules .agents/skills; do
  [[ -e "$repo_root/$path" ]] && roots+=("$repo_root/$path")
done

status=0
rg --color never --fixed-strings --ignore-case --files-with-matches --hidden \
  --glob '!.git/**' --glob '!node_modules/**' --glob '!coverage/**' \
  -- "$needle" "${roots[@]}" || status=$?

case "$status" in
  0) ;;
  1) printf 'No matching files for provider name: %s\n' "$needle" ;;
  *) printf 'Search failed (rg exit %s).\n' "$status" >&2; exit "$status" ;;
esac
