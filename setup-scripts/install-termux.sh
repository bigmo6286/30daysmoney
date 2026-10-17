#!/data/data/com.termux/files/usr/bin/bash
# 30daysmoney bot installer for Android (Termux).
#
#   ./install-termux.sh install  --bot lp-bot --ref v0.1.0 [--repo URL] [--env-file FILE]
#   ./install-termux.sh upgrade  --bot lp-bot --ref v0.2.0
#   ./install-termux.sh rollback --bot lp-bot
#   ./install-termux.sh uninstall --bot lp-bot
#
# Installs only nodejs-lts, git and termux-services (no full `pkg upgrade`), checks out a
# pinned release, runs it as a runit service with logs, and starts it on boot via
# Termux:Boot. A phone is a weak place for a wallet key: use paper mode or a wallet holding
# only what you can lose, and exempt Termux from battery optimisation.
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shared validators, env spec and env file helpers (does not run anything when sourced)
# shellcheck source=install.sh
source "$HERE/install.sh"

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
ROOT="$HOME/30daysmoney"
SVC_DIR="$PREFIX/var/service"

termux_install_packages() {
  STEP="packages"
  local have=0
  command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]] && have=1
  if ((have)) && command -v git >/dev/null && command -v sv >/dev/null; then say "node $(node -v), git and termux-services present"; return; fi
  say "Installing nodejs-lts, git, termux-services (no system-wide upgrade)"
  run pkg install -y nodejs-lts git termux-services
}

termux_fetch() {
  STEP="fetch $REF"
  local dir="$ROOT/$BOT/releases/$REF"
  run mkdir -p "$ROOT/$BOT/releases"
  if [[ -d "$dir/.git" ]]; then say "Release $REF already present"; else
    say "Fetching $REPO at $REF"
    run git clone --quiet --depth 1 --branch "$REF" "$REPO" "$dir"
  fi
  say "npm ci (exact lockfile)"
  run sh -c "cd '$dir/$BOT' && npm ci --omit=dev --no-audit --no-fund --ignore-scripts"
  run ln -sfn "$dir" "$ROOT/$BOT/current.new"
}

termux_env() {
  STEP="configure"
  local out="$ROOT/$BOT.env"
  if [[ -n "$ENV_FILE" ]]; then
    check_env "$BOT" "$ENV_FILE" || die "fix the values above in $ENV_FILE"
    ((DRY)) || { grep -v '^DATA_DIR=' "$ENV_FILE"; echo "DATA_DIR=$ROOT/$BOT/data"; } | write_env "$out"
  elif [[ -f "$out" ]]; then
    say "Keeping existing $out"
  elif ((DRY)); then
    echo "   [dry-run] prompt for: $(env_spec "$BOT" | cut -d: -f1 | paste -sd' ')"
  else
    prompt_env "$BOT" "$out"
    sed -i "s|^DATA_DIR=.*|DATA_DIR=$ROOT/$BOT/data|" "$out"
  fi
  if [[ "$(env_get "$out" MODE)" == live ]]; then warn "LIVE mode on a phone: keep only a small balance in this wallet."; fi
}

termux_service() {
  STEP="service"
  local svc="$SVC_DIR/30daysmoney-$BOT"
  say "Installing runit service $svc"
  ((DRY)) && { echo "   [dry-run] write $svc/run, $svc/log/run, ~/.termux/boot/30daysmoney-$BOT"; return; }
  mkdir -p "$svc/log" "$ROOT/$BOT/logs" "$ROOT/$BOT/data" "$HOME/.termux/boot"
  cat >"$svc/run" <<EOF
#!$PREFIX/bin/sh
cd "$ROOT/$BOT/current/$BOT" || exit 1
# Node parses the env file itself: values with & ? \$ or quotes (RPC URLs with keys) stay intact
exec node --env-file="$ROOT/$BOT.env" --import tsx src/index.ts 2>&1
EOF
  cat >"$svc/log/run" <<EOF
#!$PREFIX/bin/sh
exec svlogd -tt "$ROOT/$BOT/logs"
EOF
  cat >"$HOME/.termux/boot/30daysmoney-$BOT" <<EOF
#!$PREFIX/bin/sh
termux-wake-lock
. $PREFIX/etc/profile
sv up 30daysmoney-$BOT
EOF
  chmod 700 "$svc/run" "$svc/log/run" "$HOME/.termux/boot/30daysmoney-$BOT"
}

termux_switch() {
  STEP="start"
  local cur="$ROOT/$BOT/current"
  if [[ -L "$cur" ]]; then run ln -sfn "$(readlink "$cur")" "$ROOT/$BOT/previous"; fi
  run mv -Tf "$ROOT/$BOT/current.new" "$cur"
  run termux-wake-lock || true
  run sv-enable "30daysmoney-$BOT" || true
  run sv restart "30daysmoney-$BOT"
  ((DRY)) && return
  sleep 15
  if sv status "30daysmoney-$BOT" | grep -q '^run:'; then
    say "$BOT is running. Logs: tail -f $ROOT/$BOT/logs/current"
  else
    tail -n 30 "$ROOT/$BOT/logs/current" >&2 || true
    die "$BOT did not stay up (last logs above)"
  fi
}

termux_main() {
  parse_args "$@"
  case "$CMD" in
    install) termux_install_packages; termux_fetch; termux_env; termux_service; termux_switch
      say "Install the Termux:Boot app and open it once so the bot starts after a reboot." ;;
    upgrade) termux_fetch; termux_switch ;;
    rollback)
      [[ -L "$ROOT/$BOT/previous" ]] || die "no previous release"
      run ln -sfn "$(readlink "$ROOT/$BOT/previous")" "$ROOT/$BOT/current.new"; termux_switch ;;
    uninstall)
      run sv down "30daysmoney-$BOT" || true
      run rm -rf "$SVC_DIR/30daysmoney-$BOT" "$HOME/.termux/boot/30daysmoney-$BOT"
      say "Service removed. Code, config and data kept in $ROOT/$BOT and $ROOT/$BOT.env" ;;
    *) usage 1 ;;
  esac
}

termux_main "$@"
