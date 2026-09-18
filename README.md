# opencode-jev-orchestrator

Keeps your OpenCode session on a cheap sticky model so the cache stays warm, and only burns scarce models like Luna in temporary child subagents when Jev flags a hard turn.

Built for **[OpenCode Go](https://opencode.ai/docs/go/)** · powered by [Jev](https://typesafe.ai)

[npm](https://www.npmjs.com/package/opencode-jev-orchestrator) · [GitHub](https://github.com/aaronshaf/opencode-jev-orchestrator)

## Quick start

**1. Install**

```bash
opencode plugin opencode-jev-orchestrator -g
```

Or in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-jev-orchestrator"]
}
```

Pin: `"opencode-jev-orchestrator@0.2.1"`.

**2. Jev key** (OpenCode often misses shell exports)

```bash
printf '%s\n' "$JEV_KEY" > ~/.config/opencode/opencode-jev-orchestrator.key
chmod 600 ~/.config/opencode/opencode-jev-orchestrator.key
```

**3. Optional config**

```bash
BASE=https://raw.githubusercontent.com/aaronshaf/opencode-jev-orchestrator/main
DEST=~/.config/opencode/opencode-jev-orchestrator.json

curl -fsSL "$BASE/opencode-jev-orchestrator.example.json" -o "$DEST"          # Go only
# …go-claude / go-codex / claude / codex examples also available
```

**4. Restart OpenCode** → `/jev-status` should show key present, orchestration on, sticky parent Muse.

## How it works

This is an **orchestrator**, not a per-turn model switcher.

1. **Sticky parent** — managed turns stay on Muse Spark (`orchestration.parentTier: fast`). Cache stays warm.
2. **Jev flags** hard / easy / unsure — it does not silently swap the parent onto Luna.
3. **`jev_escalate`** — parent calls the tool; a strong child (Luna, with Kimi/Qwen fall back) gets near-full context; result merges via the tool return. Resumes send **delta** context only.
4. **Strong streak** — same child continues until Jev confidently says easy (or Jev is down / unsure → release).
5. **`jev_parallel`** — up to 3 concurrent cheap children for mechanical subtasks.
6. **Escape** — `use luna` / unmanaged picker pins still win.

| Ask | Action | Where (Go defaults) |
|---|---|---|
| Normal work | stay | Parent: Muse |
| Hard debug / design | escalate | Child: Luna (fall back if exhausted) |
| “in parallel” | parallel | Cheap children, max 3 |

## Commands

| Command | What |
|---|---|
| `/jev-status` | Key? On? Sticky parent? DeepSeek peak? |
| `/jev-explain` | Last action (stay / escalate / parallel / release) |
| `/jev-on` / `/jev-off` | Toggle this session |
| `/jev-quota` | Exhausted models |
| `/jev-exhausted <tier\|model> [hours]` | Mark exhausted |
| `/jev-reset [target]` | Clear marks |

## Multi-provider

List Claude/Codex models in tier config or use an example file — otherwise unlisted models **pin**.

## License

MIT
