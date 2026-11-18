# Pulse Runner

Connects your own server and AI subscriptions (Claude Code, Codex) to [Pulse](https://app.vitalsos.ai), so that Pulse's AI employees and AI features run on your machine, under your subscription.

The runner only makes outbound HTTPS calls. It opens no inbound ports, and Vitals gets no SSH keys.

## Install

In Pulse, go to **Settings → Servers & AI → Connect a server** to get a pairing code. It is valid for 10 minutes. Then run one of these on your server:

```bash
curl -fsSL https://app.vitalsos.ai/runner/install.sh | bash -s -- --code ABCD-1234
# or, as root
npx @vitalsos/pulse-runner connect --code ABCD-1234
```

As root, `connect` pairs the server, creates the `pulse-runner` system user and systemd service, and starts it. Then log in to your AI subscriptions:

```bash
sudo pulse-runner login claude
sudo pulse-runner login codex
```

Follow the code or link shown. Pulse then shows "Claude connected".

### Requirements

- Linux with systemd, and Node.js 20 or newer installed system-wide
- **[bubblewrap](https://github.com/containers/bubblewrap)**: `apt-get install bubblewrap`. Without it the server pairs and reports, but rejects every job.
- `claude` and/or `codex`, installed where the service user can run them (for example `/usr/local/bin`)

## Commands

| Command | What it does |
|---|---|
| `connect --code CODE [--force]` | Pair with Pulse. As root, also installs and starts the service. |
| `run` | Run in the foreground |
| `status` | Show pairing, AI logins, tool versions and sandbox state |
| `report` | Send a capability report to Pulse now |
| `login claude\|codex` | Run the official login for the runner |
| `install-service [--dry-run]` | Install the systemd service, moving a pairing made earlier without root |
| `uninstall [--dry-run]` | Tell Pulse, then remove the service, user, data and pairing |

## Where things live

| Path | Contents |
|---|---|
| `/var/lib/pulse-runner/config/credential.json` | Runner credential, mode 0600 |
| `/var/lib/pulse-runner/config/config.json` | Local settings that differ from the defaults |
| `/var/lib/pulse-runner/config/audit.log` | Local job audit, with no prompts or tokens |
| `/var/lib/pulse-runner/auth/` | Claude and Codex logins, separate from any person's |
| `/var/lib/pulse-runner/jobs/<id>/` | Per-job workdir, deleted when the job ends |
| `/opt/pulse-runner/` | The installed program |

Without root, state lives in `~/.pulse-runner`. Set `PULSE_RUNNER_HOME` to override it.

## Settings

Edit `config.json` and restart the service. Only the keys you set need to be present.

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | `2` | Jobs at once |
| `maxProfile` | `shell` | The highest profile this server accepts, whatever Pulse asks for. Set `read-only` to refuse all write and shell jobs. |
| `maxTimeLimitSec` | `14400` | The longest time limit accepted |
| `maxOutputBytes` | `104857600` | Largest output file |
| `isolation` | `bwrap` | `none` turns the sandbox off, **which lets jobs read the runner credential**. Use it only for local development. Pulse cannot change this. |

## Safety

- **Credential:** jobs run in a bubblewrap sandbox where the runner's config directory does not exist. On every start the runner tests this from inside the sandbox. If the test fails, it refuses every job. A dry run is the only exception, because it executes nothing.
- **Filesystem:** a job sees system binaries and libraries, a few named `/etc` files, its own directory, and the CLI login directory for its kind. Other applications' data and home directories are not visible.
- **Tools:** the default profile is read-only plus Pulse's MCP. `write` and `shell` need the org admin's approval in Pulse, and your local `maxProfile` can forbid them outright.
- **MCP:** each job gets its own short-lived, org-scoped Pulse token.
- **Outputs:** only declared files are uploaded. Symlinks, hard links and FIFOs are refused.
- **Revocation:** revoking in Pulse stops all jobs and deletes the credential on the server's next contact.

Known limits:

- Jobs share the host's network, so a `shell` job can reach services listening on localhost.
- A `shell` job can read the CLI login files mounted for it, because the CLI needs them to work.
- The cost cap cannot be enforced for Codex, which does not report cost. The time limit still applies.

## Troubleshooting

**Check here first:**
```bash
sudo pulse-runner status
journalctl -u pulse-runner -n 100
```

**Every job fails with `isolation_unavailable`.** See `isolation.reason` in `status`.
- *bubblewrap is not installed:* `apt-get install bubblewrap`, then restart the service.
- *bwrap could not start a sandbox*, usually on Ubuntu 24.04 or newer, where AppArmor restricts unprivileged user namespaces:
  ```bash
  sudo apt-get install apparmor-profiles
  sudo ln -s /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/
  sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
  sudo systemctl restart pulse-runner
  ```

**The pairing code is rejected.** Codes last 10 minutes and work once. Get a new one from Pulse.

**"This server is already paired."** Use `--force` to replace the pairing.

**The service stopped and does not restart.** Exit code 78 means it was revoked in Pulse or is not paired, and restarting could not help. Get a new code and run `sudo pulse-runner connect --code NEW-CODE --force`.

**Pulse says Claude is not connected.** Run `sudo pulse-runner login claude`. The runner keeps its own login, so logging in as yourself does not count.

**`claude` is "not installed", but it works for you.** The service user cannot see a CLI installed in your home directory. Install it system-wide.

**"Node is at ..., which the pulse-runner user cannot reach."** Node from nvm lives in a home directory. Install Node.js system-wide.

**The server shows offline.** It needs outbound HTTPS to `api.vitalsos.ai`. The API URL must be HTTPS, and proxies must not redirect it.

## Development

There are no runtime dependencies.

```bash
node --test test/*.test.js
```

The tests use a mock Pulse server (`test/mock-pulse.js`) and fake CLIs, and keep their files in `.test-tmp/`. The tests in `test/sandbox-real.test.js` run only where bubblewrap is installed.

See [PROTOCOL.md](PROTOCOL.md) for the API contract.

## Licence

Proprietary, Vitals Technologies. See [LICENSE](LICENSE).
