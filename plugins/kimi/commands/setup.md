---
description: Check whether the local Kimi CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup --json $ARGUMENTS
```

If the result says Kimi is unavailable:
- Use `AskUserQuestion` exactly once to ask whether the user wants to install Kimi Code now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Kimi Code (Recommended)`
  - `Skip for now`
- If the user chooses install, do not run an installer yourself. There is no npm package shortcut here; instead print the official install instructions from https://moonshotai.github.io/kimi-code/ and ask the user to run them in their terminal. On macOS/Linux that is:

```bash
curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
```

- After the user confirms the install finished, rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup --json $ARGUMENTS
```

If Kimi is already installed:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Kimi is installed but not authenticated, preserve the guidance to run `!kimi login`.
