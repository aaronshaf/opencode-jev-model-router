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

Pin a version if you prefer: `"opencode-jev-model-router@0.1.0"`.

**2. Add your Jev key** (OpenCode usually does not see shell `export`s)

```bash
printf '%s\n' "$JEV_KEY" > ~/.config/opencode/opencode-jev-router.key
chmod 600 ~/.config/opencode/opencode-jev-router.key
```

**3. Optional:** copy [example config](https://github.com/aaronshaf/opencode-jev-model-router/blob/main/opencode-jev-router.example.json) to `~/.config/opencode/opencode-jev-router.json` (defaults work without this).

**4. Restart OpenCode**, then check:

```text
/jev-status
```

You want: `Jev key present; routing ON; …`

## Day to day

1. Select a Go model the router manages (DeepSeek Flash, Muse, Luna, …). Avoid one-off pins like `hy3` if you want routing.
2. Chat as usual.
3. Watch for a toast such as `Routed to opencode-go/muse-spark-1.3-contributor · jev fast 98% 280ms`.

| Kind of ask | Typical tier | Default model |
|---|---|---|
| Typo, rename, “say hi” | `fast` | Muse Spark |
| Normal feature / fix | `balanced` | DeepSeek V4.1 Flash |
| Hard debug / design | `strong` | Luna |
| Huge migrations | `long` | Kimi K3 (off unless you enable it) |

If Jev is unreachable, your current model stays put.

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
- Or pick an unmanaged model (e.g. `opencode-go/hy3`) to **pin**

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
