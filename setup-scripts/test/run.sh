#!/usr/bin/env bash
# Tests for install.sh: validators, env checks, the systemd unit, and dry runs.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=install.sh
source ./install.sh
set +e
trap - ERR
PASS=0; FAIL=0
ok()  { if "$@"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $*"; fi; }
nok() { if "$@"; then FAIL=$((FAIL+1)); echo "FAIL (expected false): $*"; else PASS=$((PASS+1)); fi; }
has() { grep -qF -- "$2" <<<"$1"; }

T="$(mktemp -d)"
TOKEN="123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123"
SOLKEY="$(printf '5%.0s' {1..88})"

# validators
ok valid_bot lp-bot; ok valid_bot dlmm-agent; nok valid_bot checkout; nok valid_bot "lp-bot;rm"
ok valid_ref v0.1.0; ok valid_ref main; nok valid_ref "../../etc"; nok valid_ref 'v1;reboot'; nok valid_ref ""
ok valid_tg_token "$TOKEN"; nok valid_tg_token "<123:abc>"; nok valid_tg_token '"123456789:AAH-abcdefghijklmnopqrstuvwxyz_0123"'
ok valid_tg_id 12345; ok valid_tg_id -100123; nok valid_tg_id @me
ok valid_evm_key "0x$(printf 'a%.0s' {1..64})"; nok valid_evm_key "0x123"; nok valid_evm_key "$(printf 'a%.0s' {1..64})"
ok valid_sol_key "$SOLKEY"; ok valid_sol_key "[1,2,3, 4]"; nok valid_sol_key "0OIl$(printf 'a%.0s' {1..84})"
ok valid_url "https://mainnet.helius-rpc.com/?api-key=abc&x=1"; nok valid_url "ftp://x"; nok valid_url "https://a b"

# env files
cat >"$T/good.env" <<E
TG_TOKEN=$TOKEN
TG_OWNER_ID=42
MODE=paper
RPC_URL=https://rpc.example.com/?key=a=b&c
WALLET_KEY=
E
ok check_env dlmm-agent "$T/good.env"
ok check_env lp-bot "$T/good.env"
ok test "$(env_get "$T/good.env" RPC_URL)" = "https://rpc.example.com/?key=a=b&c"
ok test "$(env_get "$T/good.env" NOPE)" = ""
sed 's/^MODE=paper/MODE=live/' "$T/good.env" >"$T/live-nokey.env"
out="$(check_env dlmm-agent "$T/live-nokey.env")"; ok test $? -ne 0; ok has "$out" "WALLET_KEY: required for MODE=live"
sed "s/^TG_TOKEN=.*/TG_TOKEN=nope/" "$T/good.env" >"$T/badtok.env"
out="$(check_env lp-bot "$T/badtok.env")"; ok has "$out" "TG_TOKEN: invalid (value hidden)"; nok has "$out" "nope"
sed "s/^MODE=paper/MODE=yolo/" "$T/good.env" >"$T/badmode.env"
out="$(check_env lp-bot "$T/badmode.env")"; ok has "$out" "MODE: invalid ('yolo')"
sed "s/^WALLET_KEY=.*/WALLET_KEY=0xabc/" "$T/good.env" >"$T/badkey.env"
out="$(check_env lp-bot "$T/badkey.env")"; ok has "$out" "WALLET_KEY: invalid (value hidden)"

# write_env is 0600 and atomic
printf 'A=1\n' | write_env "$T/w.env"
ok test "$(stat -c %a "$T/w.env")" = 600
ok test "$(cat "$T/w.env")" = "A=1"

# systemd unit
unit="$(render_unit dlmm-agent)"
for want in "User=dlmm-agent" "EnvironmentFile=/etc/30daysmoney/dlmm-agent.env" "WorkingDirectory=/opt/30daysmoney/dlmm-agent/current/dlmm-agent" \
  "NoNewPrivileges=yes" "ProtectSystem=strict" "ProtectHome=yes" "StateDirectory=30daysmoney-dlmm-agent" "CapabilityBoundingSet=" "Restart=on-failure"; do
  ok has "$unit" "$want"
done
nok has "$unit" "User=root"

# dry runs (no root needed, nothing changed)
out="$(./install.sh install --bot lp-bot --ref v0.1.0 --env-file "$T/good.env" --dry-run 2>&1)"; rc=$?
ok test $rc -eq 0
ok has "$out" "[dry-run] git clone --quiet --depth 1 --branch v0.1.0 https://github.com/bigmo6286/30daysmoney.git"
ok has "$out" "npm ci --omit=dev"
ok has "$out" "[dry-run] systemctl enable --now 30daysmoney-lp-bot.service"
nok has "$out" "$TOKEN"
nok has "$out" "ufw"
out="$(./install.sh install --bot lp-bot --ref v0.1.0 --env-file "$T/good.env" --firewall --dry-run 2>&1)"
ok has "$out" "ufw"
out="$(./install.sh install --bot lp-bot --env-file "$T/good.env" --dry-run 2>&1)"; ok test $? -ne 0; ok has "$out" "--ref"
out="$(./install.sh install --bot nope --ref v1 --dry-run 2>&1)"; ok test $? -ne 0
out="$(./install.sh install --bot dlmm-agent --ref v1 --env-file "$T/live-nokey.env" --dry-run 2>&1)"; ok test $? -ne 0; ok has "$out" "WALLET_KEY: required"
out="$(./install.sh uninstall --bot lp-bot --purge --dry-run 2>&1)"; ok has "$out" "[dry-run] rm -rf"
out="$(./install.sh uninstall --bot lp-bot --dry-run 2>&1)"; nok has "$out" "rm -rf"
out="$(./install.sh install --bot dlmm-agent --ref v1 --dry-run 2>&1)"; ok has "$out" "prompt for: TG_TOKEN TG_OWNER_ID MODE RPC_URL WALLET_KEY TYPESAFE_API_KEY"

rm -rf "$T"
echo "$PASS passed, $FAIL failed"
((FAIL == 0))
