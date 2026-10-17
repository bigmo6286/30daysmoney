#!/usr/bin/env bash
# 30daysmoney bot installer for Ubuntu / Debian VPS.
#
#   sudo ./install.sh install  --bot lp-bot --ref v0.1.0   (a tag or branch) [--repo URL] [--env-file FILE] [--firewall] [--dry-run]
#   sudo ./install.sh upgrade  --bot lp-bot --ref v0.2.0
#   sudo ./install.sh rollback --bot lp-bot
#   sudo ./install.sh reconfigure --bot lp-bot
#   sudo ./install.sh uninstall --bot lp-bot [--purge]
#        ./install.sh doctor   --bot lp-bot
#
# What it does: installs Node 22 from NodeSource's signed apt repo, creates a system user
# with no login shell, checks out a pinned release into /opt/30daysmoney/<bot>/releases/<ref>,
# runs `npm ci` as that user, writes secrets to /etc/30daysmoney/<bot>.env (0600, never
# echoed), and runs the bot under a hardened systemd unit. Re-running is safe.
set -Eeuo pipefail
umask 077

BOTS=(lp-bot dlmm-agent)
REPO_DEFAULT="https://github.com/bigmo6286/30daysmoney.git"
NODE_MAJOR=22
PREFIX="${PREFIX_ROOT:-}"            # tests point this at a scratch dir
OPT="$PREFIX/opt/30daysmoney"
ETC="$PREFIX/etc/30daysmoney"
UNIT_DIR="$PREFIX/etc/systemd/system"
LOG="$PREFIX/var/log/30daysmoney-install.log"

DRY=0; FIREWALL=0; PURGE=0; BOT=""; REF=""; REPO="$REPO_DEFAULT"; ENV_FILE=""; CMD=""
STEP="start"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$*" >&2; exit 1; }
run()  { if ((DRY)); then printf '   [dry-run] %s\n' "$*"; else "$@"; fi; }
on_err() { printf '\033[31mxx\033[0m failed during: %s (see %s)\n' "$STEP" "$LOG" >&2; }
trap on_err ERR

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

# ── validation (pure; sourced by tests) ─────────────────────────────────────
valid_bot()       { local b; for b in "${BOTS[@]}"; do [[ "$1" == "$b" ]] && return 0; done; return 1; }
valid_ref()       { [[ "$1" =~ ^[A-Za-z0-9._/-]{1,80}$ && "$1" != *..* ]]; }
valid_tg_token()  { [[ "$1" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; }
valid_tg_id()     { [[ "$1" =~ ^-?[0-9]+$ ]]; }
valid_evm_key()   { [[ "$1" =~ ^0x[0-9a-fA-F]{64}$ ]]; }
valid_sol_key()   { [[ "$1" =~ ^[1-9A-HJ-NP-Za-km-z]{80,90}$ || "$1" =~ ^\[[0-9,[:space:]]+\]$ ]]; }
valid_url()       { [[ "$1" =~ ^https?://[^[:space:]]+$ ]]; }
valid_mode()      { [[ "$1" == paper || "$1" == live ]]; }

svc_user() { printf '%s' "$1"; }                     # the system user is named after the bot
unit_name() { printf '30daysmoney-%s.service' "$1"; }

# Which .env keys each bot needs, and how to check them: KEY:validator:secret(1/0):prompt
env_spec() {
  local common="TG_TOKEN:valid_tg_token:1:Telegram bot token from @BotFather
TG_OWNER_ID:valid_tg_id:0:Your numeric Telegram id (from @userinfobot)
MODE:valid_mode:0:paper or live (start with paper)"
  case "$1" in
    lp-bot) printf '%s\n%s\n' "$common" "CHAIN::0:Chain (robinhood, base, arbitrum)
RPC_URL:valid_url_or_empty:0:RPC URL (empty = the chain's public RPC)
WALLET_KEY:valid_evm_key_or_empty:1:Bot wallet private key, 0x + 64 hex (empty for paper mode). USE A FRESH WALLET.
TYPESAFE_API_KEY::1:TypeSafe API key for Jev screening (empty = autopilot screening off)" ;;
    dlmm-agent) printf '%s\n%s\n' "$common" "RPC_URL:valid_url:0:Solana RPC URL (Helius/Triton recommended)
WALLET_KEY:valid_sol_key_or_empty:1:Bot wallet secret key, base58 or [byte,array] (empty for paper mode). USE A FRESH WALLET.
TYPESAFE_API_KEY::1:TypeSafe API key for Jev screening (empty = screening blocks auto-opens)" ;;
  esac
}
valid_url_or_empty()      { [[ -z "$1" ]] || valid_url "$1"; }
valid_evm_key_or_empty()  { [[ -z "$1" ]] || valid_evm_key "$1"; }
valid_sol_key_or_empty()  { [[ -z "$1" ]] || valid_sol_key "$1"; }

# Check an env file against the spec. Prints problems; returns 1 if any.
check_env() {
  local bot="$1" file="$2" bad=0 key validator secret prompt val mode
  mode="$(env_get "$file" MODE)"
  while IFS=: read -r key validator secret prompt; do
    [[ -z "$key" ]] && continue
    val="$(env_get "$file" "$key")"
    if [[ -n "$validator" ]] && ! "$validator" "$val"; then
      if [[ "$secret" == 1 ]]; then echo "  $key: invalid (value hidden)"; else echo "  $key: invalid ('$val')"; fi
      bad=1
    fi
  done < <(env_spec "$bot")
  if [[ "$mode" == live && -z "$(env_get "$file" WALLET_KEY)" ]]; then echo "  WALLET_KEY: required for MODE=live"; bad=1; fi
  return $bad
}

env_get() { [[ -f "$1" ]] || return 0; { grep -E "^$2=" "$1" || true; } | tail -1 | cut -d= -f2-; }

# Write KEY=VALUE pairs (from stdin) to an env file atomically with mode 0600.
write_env() {
  local file="$1" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  cat >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$file"
}

prompt_env() {
  local bot="$1" out="$2" key validator secret prompt val existing
  local lines=()
  while IFS=: read -r key validator secret prompt; do
    [[ -z "$key" ]] && continue
    existing="$(env_get "$out" "$key")"
    while :; do
      if [[ "$secret" == 1 ]]; then
        read -r -s -p "$prompt${existing:+ [keep current: press Enter]}: " val </dev/tty; echo
      else
        read -r -p "$prompt${existing:+ [$existing]}: " val </dev/tty
      fi
      [[ -z "$val" ]] && val="$existing"
      if [[ -z "$validator" ]] || "$validator" "$val"; then break; fi
      warn "that doesn't look right, try again"
    done
    lines+=("$key=$val")
  done < <(env_spec "$bot")
  # keep any extra keys the owner added by hand (JUPITER_API_KEY, LOG_LEVEL…)
  local keys extra=()
  keys="$(env_spec "$bot" | cut -d: -f1 | paste -sd'|')|DATA_DIR"
  [[ -f "$out" ]] && mapfile -t extra < <(grep -Ev "^($keys)=" "$out" | grep -E '^[A-Z_][A-Z0-9_]*=' || true)
  printf '%s\n' "${lines[@]}" "${extra[@]}" "DATA_DIR=/var/lib/30daysmoney-$bot" | sed '/^$/d' | write_env "$out"
}

render_unit() {
  local bot="$1" user; user="$(svc_user "$bot")"
  cat <<EOF
[Unit]
Description=30daysmoney $bot
After=network-online.target
Wants=network-online.target

[Service]
User=$user
Group=$user
WorkingDirectory=/opt/30daysmoney/$bot/current/$bot
EnvironmentFile=/etc/30daysmoney/$bot.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=on-failure
RestartSec=10
StateDirectory=30daysmoney-$bot
StateDirectoryMode=0700
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictNamespaces=yes
CapabilityBoundingSet=
SystemCallArchitectures=native
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}

# ── steps ───────────────────────────────────────────────────────────────────
need_root() { ((DRY)) || [[ $EUID -eq 0 ]] || die "run with sudo (or use --dry-run to see the plan)"; }

install_packages() {
  STEP="packages"
  say "Installing git, curl, ca-certificates, gnupg"
  run apt-get update -qq
  run apt-get install -y -qq git curl ca-certificates gnupg
  if command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]')" == "$NODE_MAJOR" ]]; then
    say "Node $(node -v) already installed"
    return
  fi
  say "Installing Node $NODE_MAJOR from NodeSource's signed apt repository"
  run install -d -m 0755 /etc/apt/keyrings
  run sh -c "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
  run sh -c "echo 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main' > /etc/apt/sources.list.d/nodesource.list"
  run apt-get update -qq
  run apt-get install -y -qq nodejs
}

ensure_user() {
  STEP="user"
  local user; user="$(svc_user "$BOT")"
  if id "$user" >/dev/null 2>&1; then say "User $user exists"; return; fi
  say "Creating system user $user (no login shell)"
  run useradd --system --home-dir "/opt/30daysmoney/$BOT" --shell /usr/sbin/nologin "$user"
}

fetch_release() {
  STEP="fetch $REF"
  local user dir; user="$(svc_user "$BOT")"; dir="$OPT/$BOT/releases/$REF"
  run install -d -m 0750 -o "$user" -g "$user" "$OPT/$BOT" "$OPT/$BOT/releases"
  if [[ -d "$dir/.git" ]]; then
    say "Release $REF already present"
  else
    say "Fetching $REPO at $REF"
    run git clone --quiet --depth 1 --branch "$REF" "$REPO" "$dir"
    run chown -R "$user:$user" "$dir"
  fi
  say "Installing dependencies exactly as locked (npm ci)"
  run runuser -u "$user" -- sh -c "cd '$dir/$BOT' && npm ci --omit=dev --no-audit --no-fund --ignore-scripts"
  run ln -sfn "$dir" "$OPT/$BOT/current.new"
}

configure_env() {
  STEP="configure"
  local out="$ETC/$BOT.env"
  run install -d -m 0700 "$ETC"
  if [[ -n "$ENV_FILE" ]]; then
    say "Checking $ENV_FILE"
    check_env "$BOT" "$ENV_FILE" || die "fix the values above in $ENV_FILE"
    if ((DRY)); then echo "   [dry-run] copy $ENV_FILE → $out (0600)"; else { grep -v '^DATA_DIR=' "$ENV_FILE"; echo "DATA_DIR=/var/lib/30daysmoney-$BOT"; } | write_env "$out"; fi
  elif [[ -f "$out" && "$CMD" != reconfigure ]]; then
    say "Keeping existing $out (use 'reconfigure' to change it)"
    check_env "$BOT" "$out" || warn "existing config has problems; run: $0 reconfigure --bot $BOT"
  elif ((DRY)); then
    echo "   [dry-run] prompt for: $(env_spec "$BOT" | cut -d: -f1 | paste -sd' ')"
  else
    say "Configure $BOT (secrets are not echoed and never leave this server)"
    prompt_env "$BOT" "$out"
  fi
}

install_unit() {
  STEP="service"
  local unit; unit="$(unit_name "$BOT")"
  say "Installing hardened systemd unit $unit"
  if ((DRY)); then echo "   [dry-run] write $UNIT_DIR/$unit"; else render_unit "$BOT" >"$UNIT_DIR/$unit"; chmod 644 "$UNIT_DIR/$unit"; fi
  run systemctl daemon-reload
}

switch_and_start() {
  STEP="start"
  local cur="$OPT/$BOT/current" unit; unit="$(unit_name "$BOT")"
  if [[ -L "$cur" ]]; then run ln -sfn "$(readlink "$cur")" "$OPT/$BOT/previous"; fi
  run mv -Tf "$OPT/$BOT/current.new" "$cur"
  run systemctl enable --now "$unit"
  run systemctl restart "$unit"
  health_check
}

health_check() {
  STEP="health check"
  ((DRY)) && { echo "   [dry-run] wait for $(unit_name "$BOT") to stay up 20s"; return; }
  local unit; unit="$(unit_name "$BOT")"
  sleep 20
  if systemctl is-active --quiet "$unit"; then
    say "$BOT is running. Logs: journalctl -u $unit -f"
  else
    journalctl -u "$unit" -n 30 --no-pager >&2 || true
    die "$BOT did not stay up (last logs above). Fix, then: $0 reconfigure --bot $BOT, or $0 rollback --bot $BOT"
  fi
}

firewall() {
  STEP="firewall"
  ((FIREWALL)) || return 0
  local port; port="$( { sshd -T 2>/dev/null || true; } | awk '/^port /{print $2; exit}')"
  if [[ -z "$port" ]]; then
    if ((DRY)); then port="<your ssh port>"; else die "couldn't detect the SSH port (sshd -T); not touching the firewall"; fi
  fi
  say "Firewall: allow SSH on $port, deny other inbound (the bots need no open ports)"
  run apt-get install -y -qq ufw
  run ufw allow "$port/tcp"
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw --force enable
}

cmd_install() {
  need_root; install_packages; ensure_user; fetch_release; configure_env; install_unit; firewall; switch_and_start
  say "Done. Telegram your bot /start. Upgrade later with: $0 upgrade --bot $BOT --ref <tag>"
}
cmd_upgrade() { need_root; [[ -L "$OPT/$BOT/current" ]] || ((DRY)) || die "$BOT is not installed"; fetch_release; install_unit; switch_and_start; }
cmd_reconfigure() { need_root; configure_env; run systemctl restart "$(unit_name "$BOT")"; health_check; }
cmd_rollback() {
  need_root
  local prev="$OPT/$BOT/previous"
  [[ -L "$prev" ]] || ((DRY)) || die "no previous release to roll back to"
  say "Rolling back to $(readlink "$prev" 2>/dev/null || echo previous)"
  run ln -sfn "$(readlink "$prev" 2>/dev/null || echo "$prev")" "$OPT/$BOT/current.new"
  switch_and_start
}
cmd_uninstall() {
  need_root
  local unit; unit="$(unit_name "$BOT")"
  say "Stopping and removing $unit"
  run systemctl disable --now "$unit" || true
  run rm -f "$UNIT_DIR/$unit"
  run systemctl daemon-reload
  if ((PURGE)); then
    warn "Purging code, config and state (positions history) for $BOT"
    run rm -rf "$OPT/$BOT" "$ETC/$BOT.env" "/var/lib/30daysmoney-$BOT"
    run userdel "$(svc_user "$BOT")" || true
  else
    say "Kept $OPT/$BOT, $ETC/$BOT.env and /var/lib/30daysmoney-$BOT (add --purge to delete)"
  fi
}
cmd_doctor() {
  local unit ok=1; unit="$(unit_name "$BOT")"
  echo "node:     $(node -v 2>/dev/null || echo MISSING)"
  echo "release:  $(readlink "$OPT/$BOT/current" 2>/dev/null || echo none)"
  echo "previous: $(readlink "$OPT/$BOT/previous" 2>/dev/null || echo none)"
  echo "service:  $(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
  if [[ -r "$ETC/$BOT.env" ]]; then
    echo "config:   $ETC/$BOT.env ($(stat -c %a "$ETC/$BOT.env"))"
    check_env "$BOT" "$ETC/$BOT.env" || ok=0
  else
    echo "config:   not readable (run doctor with sudo)"
  fi
  echo "clock:    $(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo '?') (NTP synced)"
  ((ok)) && echo "looks healthy" || echo "problems found above"
}

parse_args() {
  CMD="${1:-}"; shift || true
  while (($#)); do
    case "$1" in
      --bot) BOT="${2:-}"; shift ;;
      --ref) REF="${2:-}"; shift ;;
      --repo) REPO="${2:-}"; shift ;;
      --env-file) ENV_FILE="${2:-}"; shift ;;
      --firewall) FIREWALL=1 ;;
      --purge) PURGE=1 ;;
      --dry-run) DRY=1 ;;
      -h|--help) usage 0 ;;
      *) die "unknown option $1" ;;
    esac
    shift
  done
  [[ -n "$CMD" ]] || usage 1
  valid_bot "$BOT" || die "--bot must be one of: ${BOTS[*]}"
  if [[ "$CMD" == install || "$CMD" == upgrade ]]; then
    [[ -n "$REF" ]] || die "--ref <tag or branch> is required: installs are pinned"
    valid_ref "$REF" || die "invalid --ref"
  fi
  [[ -z "$ENV_FILE" || -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE"
}

main() {
  parse_args "$@"
  ((DRY)) || { mkdir -p "$(dirname "$LOG")"; exec > >(tee -a "$LOG") 2>&1; }
  case "$CMD" in
    install) cmd_install ;;
    upgrade) cmd_upgrade ;;
    reconfigure) cmd_reconfigure ;;
    rollback) cmd_rollback ;;
    uninstall) cmd_uninstall ;;
    doctor) cmd_doctor ;;
    *) usage 1 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
