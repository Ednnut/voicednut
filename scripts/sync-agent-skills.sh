#!/usr/bin/env bash
# Copy canonical Agent Skills into Cline's workspace discovery directory.
# Run after changing .agents/skills; the canonical source remains .agents/skills.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_root/.agents/skills"
target_dir="$repo_root/.cline/skills"

if [[ ! -d "$source_dir" ]]; then
  printf 'Missing canonical skills directory: %s\n' "$source_dir" >&2
  exit 1
fi

mkdir -p "$target_dir"
copied=0
for skill_dir in "$source_dir"/*; do
  [[ -d "$skill_dir" ]] || continue
  [[ -f "$skill_dir/SKILL.md" ]] || continue
  skill_name="${skill_dir##*/}"
  mkdir -p "$target_dir/$skill_name"
  cp -R "$skill_dir/." "$target_dir/$skill_name/"
  copied=$((copied + 1))
done

printf 'Synced %d skills from .agents/skills/ to .cline/skills/.\n' "$copied"
