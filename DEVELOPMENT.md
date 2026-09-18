# Development

Contributor notes for `opencode-jev-model-router`. Users: see [README.md](./README.md).

## Local setup

```bash
git clone https://github.com/aaronshaf/opencode-jev-model-router.git
cd opencode-jev-model-router
npm install
npm run build
opencode plugin "$(pwd)" -g   # absolute path into ~/.config/opencode/opencode.json
```

Restart OpenCode (or start a new session) after installing or rebuilding.

### Jev key for local OpenCode

OpenCode often does not inherit shell exports. Prefer:

```bash
printf '%s\n' "$JEV_KEY" > ~/.config/opencode/opencode-jev-router.key
chmod 600 ~/.config/opencode/opencode-jev-router.key
```

Env names if you do inject them into the OpenCode process: `JEV_KEY`, `JEV_API_KEY`, `TYPESAFE_API_KEY`.

### Optional config

```bash
cp opencode-jev-router.example.json ~/.config/opencode/opencode-jev-router.json
```

Search order (later wins): `~/.config/opencode/` → `<project>/.opencode/` → `<project>/`.

Project files may change aliases / routing thresholds, but **cannot** remap tier models unless the *global* config sets `"allowProjectModels": true`.

## Scripts

| Command | What |
|---|---|
| `npm run build` | Compile `src/` → `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Build + `node --test test/*.test.mjs` |
| `npm run check` | Typecheck + tests (also `prepublishOnly`) |
| `node scripts/jev-smoke.mjs` | Live Jev classify (needs key; **not** in CI) |

## Verify it works

```bash
npm run check
node scripts/jev-smoke.mjs   # expect trivial→fast, hard→strong
```

Then in OpenCode (or `opencode run --print-logs --log-level INFO -m opencode-go/deepseek-v4.1-flash …`):

1. `/jev-status` → `Jev key present; routing ON; …`
2. `say hi` → Muse / `jev=fast`
3. A hard debugging ask → Luna / `jev=strong`
4. `use strong to …` → Luna via `override`

Look for log lines like `Routed session … to opencode-go/… (jev, jev=fast@1)`.

## CI

PRs run `.github/workflows/ci.yml`: Node 22/24, `npm ci --ignore-scripts`, `npm run check`, `npm pack --dry-run`. No secrets, no live Jev.

## Layout

- `src/` — plugin (`adapter`, `jev`, `policy`, `quota`, …)
- `test/` — unit tests (inject `askJev` / temp quota; no live network)
- `docs/OPENCODE_GO.md` — Go quota / peak-hour notes
- `schemas/config.schema.json` — config schema
