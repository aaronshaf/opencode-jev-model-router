# opencode-jev-model-router

Per-turn model routing for [OpenCode](https://opencode.ai) using [Jev](https://typesafe.ai). Aimed at **[OpenCode Go](https://opencode.ai/docs/go/)** quota stewardship: cheap/generous models on easy turns, scarce ones (Luna) only when the work is hard.

Limits: [opencode.ai/docs/go/#usage-limits](https://opencode.ai/docs/go/#usage-limits) · Go notes: [docs/OPENCODE_GO.md](./docs/OPENCODE_GO.md)

## What it does

On each real user turn, the plugin asks Jev which abstract tier fits (`fast` / `balanced` / `strong` / `long`), then mutates the pending message model before OpenCode sends it.

| Turn | Tier | Default model |
|---|---|---|
| trivial | `fast` | `opencode-go/muse-spark-1.3-contributor` |
| normal | `balanced` | `opencode-go/deepseek-v4.1-flash` |
| hard | `strong` | `opencode-go/gpt-5.6-luna` |
| exceptional | `long` | `opencode-go/kimi-k3` (off by default) |

- Fail-open if Jev is down (keeps your current model)
- Prompt overrides: `use strong`, `use luna`, `use muse`, `use balanced`, …
- During DeepSeek **peak** hours, prefers Muse/MiMo when switching into DeepSeek’s tier
- Up to 16 KB of each user turn is sent to typesafe.ai for classification

## Install (local path — recommended while developing)

```bash
git clone https://github.com/aaronshaf/opencode-jev-model-router.git
cd opencode-jev-model-router
npm install
npm run build
```

Register the plugin with OpenCode (use your absolute path):

```bash
opencode plugin "$(pwd)" -g
```

That writes the plugin into `~/.config/opencode/opencode.json` (or your global config). Restart OpenCode / start a new session after installing.

### Jev API key (required)

OpenCode often does **not** inherit your shell exports. Prefer a key file:

```bash
# one line, no quotes — chmod 600
printf '%s\n' "$JEV_KEY" > ~/.config/opencode/opencode-jev-router.key
chmod 600 ~/.config/opencode/opencode-jev-router.key
```

Accepted env names if you do export them into the OpenCode process: `JEV_KEY`, `JEV_API_KEY`, or `TYPESAFE_API_KEY`.

### Optional router config

```bash
cp opencode-jev-router.example.json ~/.config/opencode/opencode-jev-router.json
```

Search order (later wins): `~/.config/opencode/` → `<project>/.opencode/` → `<project>/`.

Project files may change aliases / routing thresholds, but **cannot** remap tier models unless the *global* config sets `"allowProjectModels": true`.

## Use

1. Start OpenCode in any project: `opencode`
2. Pick a managed Go model (e.g. DeepSeek Flash or Muse) — not a pin like `hy3`
3. Chat normally. You should see toasts like `Routed to opencode-go/… · jev fast 98% 280ms`
4. Check status: `/jev-status`

| Command | Effect |
|---|---|
| `/jev-status` | Key present?, routing on/off, DeepSeek peak/off-peak |
| `/jev-explain` | Last routing decision |
| `/jev-on` / `/jev-off` | Toggle automatic routing for this session |
| `/jev-quota` | Models marked exhausted |
| `/jev-exhausted <tier\|model> [hours]` | Manually mark exhausted |
| `/jev-reset [model\|tier]` | Clear marks |

**Pin (skip routing):** select a model that is *not* in the configured primaries/fallbacks (example: `opencode-go/hy3`). Toast: `Pinned model; Jev routing skipped`.

**Force a tier in the prompt:** `use strong to debug this race` / `use muse for this typo`.

## Verify it works

```bash
# unit + typecheck
npm run check

# live Jev classification only (needs key; not run in CI)
node scripts/jev-smoke.mjs
```

Expected smoke output: trivial → `fast`, hard → `strong`.

In OpenCode after install:

1. `/jev-status` → `Jev key present; routing ON; …`
2. Send `say hi` → expect Muse / fast toast
3. Send a hard debugging ask → expect Luna / strong toast (or `/jev-explain`)

## Develop

```bash
npm run check
```

## License

MIT
