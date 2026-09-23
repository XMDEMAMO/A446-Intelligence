#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'switch-release: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "usage: switch-release.sh <release-directory-name>"
[[ "${A446_MAINTENANCE_CONFIRMED:-}" == "yes" ]] || fail "set A446_MAINTENANCE_CONFIRMED=yes after stopping Hub and Worker services"
[[ "${A446_SERVICES_STOPPED:-}" == "yes" ]] || fail "set A446_SERVICES_STOPPED=yes only after confirming the services are stopped"
command -v realpath >/dev/null 2>&1 || fail "realpath is not available"

release_name="$1"
[[ "$release_name" =~ ^[A-Za-z0-9._-]+$ ]] || fail "release name contains unsupported characters"
releases_root="$(realpath "${A446_RELEASES_ROOT:-/srv/a446/releases}")"
candidate="$(realpath "${releases_root}/${release_name}")"
[[ "$(dirname -- "$candidate")" == "$releases_root" ]] || fail "release must be a direct child of $releases_root"
[[ -f "$candidate/apps/server-hub/src/server-hub-cli.mjs" ]] || fail "release is missing Server Hub entrypoint"
[[ -f "$candidate/apps/web/dist/index.html" ]] || fail "release is missing the Web production build"

deployment_root="$(dirname -- "$releases_root")"
current_input="${A446_CURRENT_LINK:-${deployment_root}/current}"
current_parent="$(realpath -m "$(dirname -- "$current_input")")"
current="${current_parent}/$(basename -- "$current_input")"
[[ "$current_parent" == "$deployment_root" ]] || fail "current link must be a direct child of $deployment_root"
if [[ -e "$current" && ! -L "$current" ]]; then
  fail "refusing to replace non-symbolic-link path: $current"
fi
if [[ -L "$current" && ! -e "$current" ]]; then
  fail "current link is dangling; repair it manually before switching"
fi

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
next_link="${current}.next-${stamp}"
previous_link="${current}.previous-${stamp}"
[[ ! -e "$next_link" && ! -L "$next_link" && ! -e "$previous_link" && ! -L "$previous_link" ]] || fail "release link collision"
ln -s -- "$candidate" "$next_link"

had_previous=false
if [[ -L "$current" ]]; then
  mv -- "$current" "$previous_link"
  had_previous=true
fi
if ! mv -- "$next_link" "$current"; then
  if [[ "$had_previous" == true ]]; then mv -- "$previous_link" "$current"; fi
  fail "could not activate release"
fi

printf 'Active release: %s -> %s\n' "$current" "$candidate"
if [[ "$had_previous" == true ]]; then
  printf 'Previous release link retained: %s\n' "$previous_link"
fi
printf 'Run migrations, restart services, and execute public endpoint verification.\n'
