# Verification Before Completion

Core law:

- No completion claim without fresh verification evidence.

Before claiming success:

1. Identify the command or evidence that proves the claim.
2. Run it now, not from memory.
3. Read the full result, including failures and exit status.
4. Only then state what is actually true.

Guardrails:

- Agent reports are not proof.
- Partial checks are not proof.
- "Should work" is not proof.
- If verification fails, report the real state with evidence instead of optimistic wording.

Environment constraints:

- Never run `npm install`, `yarn install`, `pnpm install`, or any package manager install command. The worker sandbox is network-restricted and install commands will hang or fail with ENOTCACHED.
- Assume all project dependencies are pre-installed by the host before dispatch.
- If a test or build step fails due to a missing module, record the missing module names and mark the verification step as **blocked** — do not attempt to install, retry, or work around it.
