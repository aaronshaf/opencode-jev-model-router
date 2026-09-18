# opencode-jev-model-router

Automatic per-turn model picking for [OpenCode](https://opencode.ai), powered by [Jev](https://typesafe.ai). Built for **[OpenCode Go](https://opencode.ai/docs/go/)**: easy turns burn generous models; hard turns get Luna.

[npm](https://www.npmjs.com/package/opencode-jev-model-router) · [GitHub](https://github.com/aaronshaf/opencode-jev-model-router)

## Quick start

**1. Install the plugin**

```bash
opencode plugin opencode-jev-model-router -g
```

Or add it to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-jev-model-router"]
}
```

Pin a version if you prefer: `"opencode-jev-model-router@0.1.4"`.

**2. Add your Jev key** (OpenCode usually does not see shell `export`s)

```bash
printf '%s\n' "$JEV_KEY" > ~/.config/opencode/opencode-jev-router.key
chmod 600 ~/.config/opencode/opencode-jev-router.key
```

**3. Optional config** — built-in defaults are **OpenCode Go only**. Pick an example that matches how you use OpenCode:

```bash
BASE=https://raw.githubusercontent.com/aaronshaf/opencode-jev-model-router/main
DEST=~/.config/opencode/opencode-jev-router.json

# Go only (same as built-in defaults)
curl -fsSL "$BASE/opencode-jev-router.example.json" -o "$DEST"

# Go + Claude
curl -fsSL "$BASE/opencode-jev-router.go-claude.example.json" -o "$DEST"

# Go + Codex
curl -fsSL "$BASE/opencode-jev-router.go-codex.example.json" -o "$DEST"

# Claude only (no Go)
curl -fsSL "$BASE/opencode-jev-router.claude.example.json" -o "$DEST"

# Codex / OpenAI only (no Go)
curl -fsSL "$BASE/opencode-jev-router.codex.example.json" -o "$DEST"
```

**4. Restart OpenCode**, then check:

```text
/jev-status
```

You want: `Jev key present; routing ON; …`

## How routing picks models

Jev chooses a **tier** (`fast` / `balanced` / `strong` / `long`). The plugin then picks the first eligible model from that tier’s `model` + `fallbacks` in the plugin config (or the built-in Go defaults if you have no config file).

If your current model is **not** in that list, the turn is **pinned** — no routing. So Claude or Codex only participate after you add them to a tier (or use an example above).

## Day to day

1. Start on a **managed** model (one listed in the defaults or your config). Unlisted models pin.
2. Chat as usual.
3. Watch for a toast such as `Routed to opencode-go/muse-spark-1.3-contributor · jev fast 98% 280ms`.

| Kind of ask | Typical tier | Default model (Go) |
|---|---|---|
| Typo, rename, “say hi” | `fast` | Muse Spark |
| Normal feature / fix | `balanced` | DeepSeek V4.1 Flash |
| Hard debug / design | `strong` | Luna |
| Huge migrations | `long` | Kimi K3 (off unless you enable it) |

If Jev is unreachable, your current model stays put.

### Also using Claude or Codex?

Connect providers with `/connect`, then pick a config that lists those models (otherwise they **pin** and won’t route):

| Setup | Example |
|---|---|
| Go only | [opencode-jev-router.example.json](./opencode-jev-router.example.json) (or skip config — built-in) |
| Go + Claude | [opencode-jev-router.go-claude.example.json](./opencode-jev-router.go-claude.example.json) |
| Go + Codex | [opencode-jev-router.go-codex.example.json](./opencode-jev-router.go-codex.example.json) |
| Claude only | [opencode-jev-router.claude.example.json](./opencode-jev-router.claude.example.json) |
| Codex / OpenAI only | [opencode-jev-router.codex.example.json](./opencode-jev-router.codex.example.json) |

Adjust model IDs to whatever `/models` shows for your account.

### Force a tier in the prompt

```text
use muse for this typo
use strong to debug this race
use luna
use balanced for this endpoint
```

### Skip routing for a session

- `/jev-off` — stay on whatever model you picked  
- `/jev-on` — turn automatic routing back on  
- Or pick an unmanaged model (not in your tier lists) to **pin**

### When a model hits its Go allowance

```text
/jev-exhausted strong          # skip Luna for the default cooldown
/jev-exhausted opencode-go/gpt-5.6-luna 8
/jev-quota                     # what’s blocked
/jev-reset strong              # clear that mark
```

### Inspect a decision

```text
/jev-explain
```

## Commands

| Command | What it does |
|---|---|
| `/jev-status` | Key OK? Routing on? DeepSeek peak or off-peak? |
| `/jev-explain` | Why the last turn chose its model |
| `/jev-on` / `/jev-off` | Enable / disable routing this session |
| `/jev-quota` | List exhausted models |
| `/jev-exhausted <tier\|model> [hours]` | Mark exhausted |
| `/jev-reset [tier\|model]` | Clear exhaustion (all if omitted) |

## Privacy

Each user turn (up to ~16 KB of text) is sent to typesafe.ai so Jev can classify the tier.

## More

- Go limits & peak hours: [docs/OPENCODE_GO.md](./docs/OPENCODE_GO.md)
- Building / testing the plugin: [DEVELOPMENT.md](./DEVELOPMENT.md)

## License

MIT
