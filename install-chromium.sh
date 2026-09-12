#!/usr/bin/env bash
#
# install-chromium.sh — install the Chromium build browser-mcp is verified against.
#
# Verified environment:
#   Ubuntu 26.04 LTS (aarch64, proot-distro) · Chromium 150.0.7871.100
#
# Why Ubuntu cannot just `apt install chromium`:
#   On Ubuntu 26.04 the `chromium-browser` package is a *transitional* package
#   (2:1snap1-0ubuntu4, "Provides: chromium") that installs the Chromium snap.
#   Snap is unavailable inside proot-distro, so that route cannot work here.
#   The working install pulls the real .deb from the Debian bookworm archive:
#
#       /etc/apt/sources.list.d/debian-bookworm.list
#         deb [trusted=yes] http://deb.debian.org/debian bookworm main
#       apt-get install -y chromium
#
#   (Recorded in /var/log/apt/history.log, 2026-07-31 14:32:31.)
#
# What this script adds over that one-liner:
#   * idempotent — a working Chromium is detected and left untouched;
#   * apt pinning — the Debian archive can only satisfy Chromium packages, it
#     never overrides an Ubuntu package (the original install had no pin, which
#     risks mixing the two archives on any later `apt upgrade`);
#   * signature verification — uses debian-archive-keyring when available
#     (the original `[trusted=yes]` disables verification entirely);
#   * a real verification step — runs Chromium headless with the same flags
#     browser-mcp uses, not just `chromium --version`.
#
# Usage:
#   sudo ./install-chromium.sh              install (prompts once)
#   sudo ./install-chromium.sh --yes        install without prompting
#        ./install-chromium.sh --dry-run    show the plan, change nothing
#   sudo ./install-chromium.sh --uninstall  remove the repo/pin this script added
#
# Environment overrides:
#   CHROMIUM_DEBIAN_MIRROR  (default http://deb.debian.org/debian)
#   CHROMIUM_DEBIAN_SUITE   (default bookworm)
#
set -euo pipefail

ORIGINAL_ARGS=("$@")

DEBIAN_MIRROR="${CHROMIUM_DEBIAN_MIRROR:-http://deb.debian.org/debian}"
DEBIAN_SUITE="${CHROMIUM_DEBIAN_SUITE:-bookworm}"

SOURCE_FILE="/etc/apt/sources.list.d/browser-mcp-debian.list"
PIN_FILE="/etc/apt/preferences.d/browser-mcp-chromium"
KEYRING="/usr/share/keyrings/debian-archive-keyring.gpg"

# Same locations src/browser.js auto-detects.
KNOWN_PATHS=(
  /usr/bin/chromium-browser
  /usr/bin/chromium
  /usr/bin/google-chrome
  /usr/bin/google-chrome-stable
)

# Mirrors DEFAULT_FLAGS from src/browser.js closely enough for a smoke test.
SMOKE_FLAGS=(
  --headless
  --no-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --use-gl=swiftshader
  --disable-features=dbus
  --no-zygote
  --disable-crash-reporter
)

DRY_RUN=0
ASSUME_YES=0
MODE=install

info() { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '  warning: %s\n' "$*" >&2; }
die()  { printf '  error: %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

wrote() {
  if [ "$DRY_RUN" -eq 1 ]; then info "would write $1"; else info "wrote $1"; fi
}

usage() {
  sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run)   DRY_RUN=1 ;;
      -y|--yes)    ASSUME_YES=1 ;;
      --uninstall) MODE=uninstall ;;
      -h|--help)   usage ;;
      *)           die "unknown argument: $1 (try --help)" ;;
    esac
    shift
  done
}

require_root() {
  [ "$(id -u)" -eq 0 ] && return 0
  if command -v sudo >/dev/null 2>&1; then
    printf 'Root is required — re-running with sudo...\n' >&2
    exec sudo -E bash "${BASH_SOURCE[0]}" "${ORIGINAL_ARGS[@]}"
  fi
  die "root is required (run with sudo)"
}

confirm_install() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  if [ ! -t 0 ]; then
    die "refusing to modify the system without confirmation — pass --yes"
  fi
  printf '\nThis will add the Debian "%s" archive (pinned) and install Chromium.\n' "$DEBIAN_SUITE"
  printf 'Continue? [y/N] '
  local reply
  read -r reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) die "aborted by user" ;;
  esac
}

# Prints the first usable Chromium binary path, or nothing.
detect_chromium_path() {
  local p
  for p in "${KNOWN_PATHS[@]}"; do
    if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
  done
  if command -v chromium >/dev/null 2>&1; then command -v chromium; return 0; fi
  if command -v chromium-browser >/dev/null 2>&1; then command -v chromium-browser; return 0; fi
  return 1
}

chromium_runs() {
  "$1" --version >/dev/null 2>&1
}

smoke_test() {
  local bin="$1"
  info "running headless smoke test with the project's flags..."
  if timeout 60 "$bin" "${SMOKE_FLAGS[@]}" --dump-dom about:blank >/dev/null 2>&1; then
    info "headless smoke test: OK"
    return 0
  fi
  warn "headless smoke test failed — check the Chromium build for missing libraries"
  return 1
}

reproduce_env() {
  # shellcheck disable=SC1091
  [ -r /etc/os-release ] && . /etc/os-release
  local pretty="${PRETTY_NAME:-unknown}"
  info "host: $pretty ($(uname -m))"
}

is_apt_based() {
  command -v apt-get >/dev/null 2>&1
}

# Debian/Ubuntu archives present in apt sources vs. a real candidate in Ubuntu.
apt_candidate() {
  apt-cache policy chromium 2>/dev/null | awk '/Candidate:/ {print $2; exit}'
}

debian_repo_present() {
  local f
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do
    [ -f "$f" ] || continue
    if grep -q 'deb\.debian\.org' "$f" 2>/dev/null && grep -q "$DEBIAN_SUITE" "$f" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

write_debian_repo() {
  # Prefer signature verification; fall back to [trusted=yes] with a warning
  # only when the Debian archive keyring cannot be obtained.
  local options="signed-by=$KEYRING"
  if [ ! -f "$KEYRING" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      apt-cache show debian-archive-keyring >/dev/null 2>&1 || options="trusted=yes"
    else
      step "Installing debian-archive-keyring (for signature verification)"
      apt-get install -y debian-archive-keyring >/dev/null 2>&1 || true
      [ -f "$KEYRING" ] || options="trusted=yes"
    fi
  fi
  if [ "$options" = "trusted=yes" ]; then
    warn "falling back to [trusted=yes] — this Debian archive will NOT be signature-verified"
  fi

  step "Adding the Debian $DEBIAN_SUITE archive (pinned to Chromium)"
  run tee "$SOURCE_FILE" >/dev/null <<EOF
# Managed by browser-mcp/install-chromium.sh — do not edit by hand.
# Ubuntu does not ship a real Chromium .deb; this archive supplies it.
deb [$options] $DEBIAN_MIRROR $DEBIAN_SUITE main
EOF
  wrote "$SOURCE_FILE"
}

write_apt_pin() {
  # Priority 500 for Chromium itself, 100 for everything else: the Debian
  # archive can satisfy what Ubuntu lacks, but never overrides an Ubuntu
  # package. This is what keeps the system from mixing the two archives.
  step "Pinning the Debian archive to Chromium packages only"
  run tee "$PIN_FILE" >/dev/null <<EOF
# Managed by browser-mcp/install-chromium.sh — do not edit by hand.
Package: chromium chromium-common chromium-sandbox
Pin: release n=$DEBIAN_SUITE
Pin-Priority: 500

Package: *
Pin: release n=$DEBIAN_SUITE
Pin-Priority: 100
EOF
  wrote "$PIN_FILE"
}

apt_install_chromium() {
  step "Refreshing package lists"
  run apt-get update
  step "Installing chromium"
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y chromium
}

print_manual_hint() {
  cat <<'EOF'
  This script automates the Debian/Ubuntu path only.

  Other distributions — install Chromium with your package manager and let
  browser-mcp auto-detect it (or point CHROMIUM_PATH at the binary):

    Fedora/RHEL   sudo dnf install -y chromium
    Arch          sudo pacman -S --noconfirm chromium
    openSUSE      sudo zypper install -y chromium
    Alpine        sudo apk add chromium
    macOS         brew install --cask chromium
EOF
}

print_footer() {
  local bin="$1" version
  version="$("$bin" --version 2>/dev/null || echo 'unknown')"
  step "Done"
  info "binary:  $bin"
  info "version: $version"
  info "browser-mcp auto-detects this path; no CHROMIUM_PATH needed."
  printf '\n  Run the server with:  node %s/index.js\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
}

do_uninstall() {
  [ "$DRY_RUN" -eq 1 ] || require_root
  step "Removing configuration added by this script"
  local removed=0 f
  for f in "$SOURCE_FILE" "$PIN_FILE"; do
    [ -e "$f" ] || continue
    run rm -f "$f"
    if [ "$DRY_RUN" -eq 1 ]; then info "would remove $f"; else info "removed $f"; fi
    removed=1
  done

  if [ "$removed" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
    apt-get update >/dev/null 2>&1 || true
  fi
  [ "$removed" -eq 1 ] || info "nothing managed by this script was found (a pre-existing Debian source is left untouched)"

  cat <<'EOF'

  The Chromium packages themselves are intentionally left installed.
  To remove them as well:

    sudo apt-get purge chromium chromium-common chromium-sandbox
    sudo apt-get autoremove
EOF
}

main() {
  parse_args "$@"

  if [ "$MODE" = uninstall ]; then
    do_uninstall
    return 0
  fi

  reproduce_env

  local existing
  if existing="$(detect_chromium_path)" && chromium_runs "$existing"; then
    step "Chromium is already installed"
    info "binary:  $existing"
    info "version: $("$existing" --version 2>/dev/null)"
    info "nothing to do — system configuration left untouched."
    return 0
  fi

  is_apt_based || { print_manual_hint; die "apt-get not found"; }

  if [ "$DRY_RUN" -eq 0 ]; then
    require_root
    confirm_install
  fi

  local candidate
  candidate="$(apt_candidate)"
  if [ -n "${candidate:-}" ] && [ "$candidate" != "(none)" ]; then
    info "apt already offers chromium $candidate from the configured archives"
  else
    if debian_repo_present; then
      info "a Debian $DEBIAN_SUITE archive is already configured; reusing it"
    else
      write_debian_repo
    fi
    if [ ! -e "$PIN_FILE" ]; then
      write_apt_pin
    else
      info "apt pin already present: $PIN_FILE"
    fi
  fi

  apt_install_chromium

  step "Verifying the install"
  local bin
  if ! bin="$(detect_chromium_path)"; then
    die "Chromium was installed but no known binary path was found — set CHROMIUM_PATH"
  fi
  info "found: $bin"
  "$bin" --version
  smoke_test "$bin"
  print_footer "$bin"
}

main "$@"
