#!/bin/sh
# Install, uninstall, or inspect the dsh-weixin-gateway user unit.
#
#   deploy/systemd/install.sh            install, enable, start, print status
#   deploy/systemd/install.sh uninstall  stop, disable, remove the unit
#   deploy/systemd/install.sh status     systemctl status + last log lines
#
# Run as the desktop user that owns the DSH home. Never use sudo: a user unit
# installed into root's config cannot reach the user's session, and DSH would
# read root's ~/.dsh instead of yours.
set -eu

unit=dsh-weixin-gateway.service
here=$(cd "$(dirname "$0")" && pwd)
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

warn_linger() {
  # Linger lets the user manager (and this unit) run without an open login.
  if ! command -v loginctl >/dev/null 2>&1; then return; fi
  linger=$(loginctl show-user "$(id -un)" -p Linger 2>/dev/null | cut -d= -f2 || echo unknown)
  if [ "$linger" = "no" ]; then
    echo "note: lingering is off; run 'loginctl enable-linger $(id -un)' so the" >&2
    echo "      gateway also starts after a reboot without logging in." >&2
  fi
}

case "${1:-install}" in
  install)
    if [ "$(id -u)" -eq 0 ]; then
      echo "error: run this as your desktop user, not as root" >&2
      exit 1
    fi
    if ! command -v dsh >/dev/null 2>&1; then
      echo "warning: 'dsh' is not on PATH; the unit hardcodes \$HOME/.local/bin/dsh" >&2
    fi
    mkdir -p "$dest"
    install -m 0644 "$here/$unit" "$dest/$unit"
    systemctl --user daemon-reload
    systemctl --user enable --now "$unit"
    systemctl --user status "$unit" --no-pager || true
    warn_linger
    echo
    echo "logs: journalctl --user -u $unit -f"
    ;;
  uninstall)
    systemctl --user disable --now "$unit" || true
    rm -f "$dest/$unit"
    systemctl --user daemon-reload
    echo "removed $dest/$unit"
    ;;
  status)
    systemctl --user status "$unit" --no-pager || true
    echo
    journalctl --user -u "$unit" -n 50 --no-pager || true
    ;;
  *)
    echo "usage: $0 [install|uninstall|status]" >&2
    exit 2
    ;;
esac
