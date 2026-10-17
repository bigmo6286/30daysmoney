# Setup scripts

One-command installs of our bots for the paid setup service, on an **Ubuntu/Debian VPS** or an **Android phone (Termux)**. Rebuilt from FlipZ3ro's hermes-quickstart / hermes-termux, minus their problems (root services, `curl | bash` of unpinned code, secrets on the command line, an open LLM proxy on port 80, a firewall that can lock you out).

## VPS

```bash
git clone https://github.com/bigmo6286/30daysmoney.git && cd 30daysmoney/setup-scripts
sudo ./install.sh install --bot lp-bot --ref <release tag> --dry-run   # see the plan first
sudo ./install.sh install --bot lp-bot --ref <release tag>
```

What it does:

| | |
|---|---|
| Node 22 | from NodeSource's **signed** apt repo (skipped if already installed) |
| user | `lp-bot` / `dlmm-agent` system user, no login shell, owns only its own dirs |
| code | pinned release in `/opt/30daysmoney/<bot>/releases/<ref>`, `npm ci` from the lockfile, `current` / `previous` symlinks |
| secrets | asked at hidden prompts (or `--env-file`), format-checked, written to `/etc/30daysmoney/<bot>.env` with mode 0600, never echoed or logged |
| service | `30daysmoney-<bot>.service`: `User=` the bot user, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, no capabilities, state in `/var/lib/30daysmoney-<bot>` |
| health | waits 20s and fails loudly with the last logs if the bot didn't stay up |
| firewall | only with `--firewall`: allows the SSH port it reads from `sshd -T`, denies other inbound. The bots need no open ports (Telegram long-polling) |

Day-2:

```bash
sudo ./install.sh upgrade     --bot lp-bot --ref <new tag>
sudo ./install.sh rollback    --bot lp-bot              # back to the previous release
sudo ./install.sh reconfigure --bot lp-bot              # change keys/settings, Enter keeps a value
sudo ./install.sh doctor      --bot lp-bot              # versions, service state, config check (values hidden)
sudo ./install.sh uninstall   --bot lp-bot [--purge]    # --purge also deletes config and position history
```

Non-interactive: `--env-file my.env` (checked before anything is written). Re-running `install` is safe: existing config is kept, releases already fetched are reused.

## Termux (Android)

```bash
pkg install git && git clone https://github.com/bigmo6286/30daysmoney.git && cd 30daysmoney/setup-scripts
./install-termux.sh install --bot dlmm-agent --ref <release tag>
```

Installs only `nodejs-lts`, `git`, `termux-services` (no system-wide upgrade), runs the bot as a runit service with `svlogd` logs, holds a wake-lock, and adds a Termux:Boot hook. The env file is read by Node itself (`--env-file`), so RPC URLs with `&` or `?` are safe. A phone is a weak home for a wallet key: use paper mode or a wallet holding only what you can lose, and exempt Termux from battery optimisation.

## Tests

```bash
./test/run.sh       # validators, env checks (secrets never printed), the systemd unit, dry runs
shellcheck -x install.sh install-termux.sh test/run.sh
```
