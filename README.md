# Kimi Code plugin for Claude Code

Use Kimi Code from inside Claude Code for code reviews or to delegate tasks to Kimi.

This plugin is for Claude Code users who want an easy way to start using Kimi Code from the workflow
they already have.

> **About this project:** this repository is a port of OpenAI's
> [codex-plugin-cc](https://github.com/openai/codex-plugin-cc), and the port
> itself was built with [Kimi Code](https://moonshotai.github.io/kimi-code/).
> Its goal is to let Claude Code make full use of Kimi's capabilities.

## What You Get

- `/kimi:review` for a normal read-only Kimi review
- `/kimi:adversarial-review` for a steerable challenge review
- `/kimi:rescue`, `/kimi:transfer`, `/kimi:status`, `/kimi:result`, and `/kimi:cancel` to delegate work, hand off sessions, and manage background jobs
- `/kimi:setup` to check the local Kimi Code CLI and manage the optional review gate

## Requirements

- **Kimi Code CLI installed and logged in via `kimi login`.**
  - Install and sign-in options are covered in the official docs: <https://moonshotai.github.io/kimi-code/>.
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add thxcode/kimi-code-plugin-cc
```

Install the plugin:

```bash
/plugin install kimi@moonshotai-kimi
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/kimi:setup
```

`/kimi:setup` will tell you whether Kimi Code is ready. If the Kimi Code CLI is missing, it offers the official install instructions.

If you prefer to install the Kimi Code CLI yourself, follow the official install docs at <https://moonshotai.github.io/kimi-code/>. On macOS/Linux that is:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

If Kimi Code is installed but not logged in yet, run:

```bash
!kimi login
```

After install, you should see:

- the slash commands listed below
- the `kimi:kimi-rescue` subagent in `/agents`

One simple first run is:

```bash
/kimi:review --background
/kimi:status
/kimi:result
```

## Usage

| Command | What it does | Key flags |
| --- | --- | --- |
| `/kimi:review` | Read-only Kimi review of uncommitted or branch changes | `--base <ref>`, `--wait`, `--background` |
| `/kimi:adversarial-review` | Read-only challenge review with optional focus text | `--base <ref>`, `--wait`, `--background`, `[focus ...]` |
| `/kimi:rescue` | Delegate a task to Kimi via the `kimi:kimi-rescue` subagent (write-capable by default) | `--resume`, `--fresh`, `--model k3\|k2.7\|highspeed`, `--thinking on\|off`, `--wait`, `--background` |
| `/kimi:transfer` | Seed a resumable Kimi session from the current Claude session | `--source <claude-jsonl>` |
| `/kimi:status` | Show active and recent Kimi jobs | `[job-id]`, `--wait`, `--all` |
| `/kimi:result` | Show the stored final output of a finished job | `[job-id]` |
| `/kimi:cancel` | Cancel an active background job | `[job-id]` |
| `/kimi:setup` | Check the Kimi Code CLI and manage the review gate | `--enable-review-gate`, `--disable-review-gate` |

### `/kimi:review`

Runs a normal Kimi review on your current work. Under the hood it is a prompt-driven review through the shared Kimi runtime, with the same read-only contract you would expect from a built-in reviewer.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/kimi:adversarial-review`](#kimiadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/kimi:review
/kimi:review --base main
/kimi:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/kimi:status`](#kimistatus) to check on the progress and [`/kimi:cancel`](#kimicancel) to cancel the ongoing task.

### `/kimi:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/kimi:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/kimi:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/kimi:adversarial-review
/kimi:adversarial-review --base main challenge whether this was the right caching and retry design
/kimi:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/kimi:rescue`

Hands a task to Kimi through the `kimi:kimi-rescue` subagent.

Use it when you want Kimi to:

- investigate a bug
- try a fix
- continue a previous Kimi task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repo.

Examples:

```bash
/kimi:rescue investigate why the tests started failing
/kimi:rescue fix the failing test with the smallest safe patch
/kimi:rescue --resume apply the top fix from the last run
/kimi:rescue --model k2.7 --thinking on investigate the flaky integration test
/kimi:rescue --model highspeed fix the issue quickly
/kimi:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Kimi:

```text
Ask Kimi to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--thinking`, Kimi chooses its own defaults.
- `--model` accepts `k3` (the default top model, `kimi-code/k3`), `k2.7` (`kimi-code/kimi-for-coding`), `highspeed`, or raw `kimi-code/...` values; `highspeed` maps to `kimi-code/kimi-for-coding-highspeed`.
- rescue runs are write-capable by default (`--write`); ask for read-only behavior when you only want diagnosis or research.
- follow-up rescue requests can continue the latest Kimi session in the repo.

### `/kimi:transfer`

Creates a new Kimi session seeded from the current Claude Code session and prints a `kimi -r <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Kimi.

Examples:

```bash
/kimi:transfer
/kimi:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer condenses the Claude transcript into a seed prompt for a new Kimi session, so it is lossy and costs one prompt; the resulting session can be continued in the Kimi CLI with `kimi -r <session-id>`. The source must be under `~/.claude/projects`.

### `/kimi:status`

Shows running and recent Kimi jobs for the current repository.

Examples:

```bash
/kimi:status
/kimi:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/kimi:result`

Shows the final stored Kimi output for a finished job.
When available, it also includes the Kimi session ID so you can reopen that run directly in Kimi with `kimi -r <session-id>`.

Examples:

```bash
/kimi:result
/kimi:result task-abc123
```

### `/kimi:cancel`

Cancels an active background Kimi job.

Examples:

```bash
/kimi:cancel
/kimi:cancel task-abc123
```

### `/kimi:setup`

Checks whether Kimi Code is installed and authenticated.
If the Kimi Code CLI is missing, it offers the official install instructions.

You can also use `/kimi:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/kimi:setup --enable-review-gate
/kimi:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Kimi review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Kimi loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/kimi:review
```

### Hand A Problem To Kimi

```bash
/kimi:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/kimi:adversarial-review --background
/kimi:rescue --background investigate the flaky test
```

Then check in with:

```bash
/kimi:status
/kimi:result
```

## Kimi Code Integration

The Kimi Code plugin talks to your local Kimi Code CLI through `kimi acp`, the CLI's [Agent Client Protocol](https://moonshotai.github.io/kimi-code/) mode. A shared broker keeps one long-lived `kimi acp` endpoint per workspace, so every command reuses the same Kimi process, the same machine-local authentication state, and the same configuration.

### Common Configurations

If you want to change the default model or the default thinking behavior that gets used by the plugin, you can define that inside your user-level `~/.kimi-code/config.toml`. For example, to always use `k2.7` (`kimi-code/kimi-for-coding`) with thinking on, add:

```toml
default_model = "kimi-code/kimi-for-coding"

[thinking]
enabled = true
```

Check out the Kimi Code docs for more [configuration options](https://moonshotai.github.io/kimi-code/).

### Moving The Work Over To Kimi

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed inside Kimi by running `kimi -r <session-id>` with the specific session ID you received from running `/kimi:result` or `/kimi:status`.

This way you can review the Kimi work or continue the work there.

## Differences from the Codex plugin

This plugin is a port of OpenAI's Codex plugin for Claude Code. The command surface is the same, but a few mechanics differ:

- **Reviews are prompt-driven.** Kimi has no built-in review RPC, so `/kimi:review` and `/kimi:adversarial-review` run curated review prompts through the shared runtime instead of calling a native reviewer.
- **`--thinking on|off` replaces `--effort`.** Reasoning control is a boolean thinking toggle rather than graded effort levels.
- **Transfer seeds a new session.** `/kimi:transfer` condenses the Claude transcript into a seed prompt for a new Kimi session — lossy, and it costs one prompt — instead of Codex's native session import.
- **Read-only is enforced by permission policy.** Review runs are kept read-only through Kimi's permission policy rather than an OS-level sandbox.

### Will a stuck Kimi run hang my job forever?

No. Every turn is watched for total upstream silence (no streamed output at all):

- After `KIMI_COMPANION_STALL_WARN_MS` (default `120000`, 2 minutes) of silence the job logs a heartbeat and its phase flips to `waiting`, so `/kimi:status` no longer misleadingly shows `starting`.
- After `KIMI_COMPANION_STALL_TIMEOUT_MS` (default `600000`, 10 minutes) of silence the turn is cancelled upstream and the job fails with a clear "stalled turn was cancelled" error instead of hanging forever.

Set either variable to `0` to disable that knob. If a background worker is killed without `/kimi:cancel`, the shared broker also cancels the orphaned upstream turn on its own.

## FAQ

### Do I need a separate Kimi account for this plugin?

If you are already signed into Kimi Code on this machine, that account should work immediately here too. This plugin uses your local Kimi Code CLI authentication.

If you only use Claude Code today and have not used Kimi Code yet, you will need to sign in first — `kimi login` supports both the Kimi Code OAuth device-code flow and Kimi Platform API keys. Run `/kimi:setup` to check whether Kimi Code is ready, and use `!kimi login` if it is not.

### Does the plugin use a separate Kimi runtime?

No. This plugin delegates through your local Kimi Code CLI via `kimi acp` on the same machine.

That means:

- it uses the same Kimi Code install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Kimi config I already have?

Yes. If you already use Kimi Code, the plugin picks up the same [configuration](#common-configurations) from `~/.kimi-code/config.toml`.

### Can I keep using my current API key or custom provider setup?

Yes. Because the plugin uses your local Kimi Code CLI, your existing providers, sign-in method, and config still apply.

### Can the Kimi and Codex plugins run side by side?

Yes. Older releases could cross-wire the two: both plugins re-exported the generic `CLAUDE_PLUGIN_DATA` into the session environment, so one plugin's workers could resolve the other's state directory and reuse its cached broker — surfacing as `unknown variant` errors (e.g. `session/new` sent to Codex's broker). The plugin now keeps its state under a Kimi-specific pointer (`KIMI_COMPANION_PLUGIN_DATA`), only reuses broker sessions it can attribute to itself, and verifies the broker's identity during the ACP handshake — a foreign broker is rejected and the run falls back to a direct connection instead of failing. Cached sessions poisoned before this fix are discarded automatically on the next run.
