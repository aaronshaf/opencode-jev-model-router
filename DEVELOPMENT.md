# Development

Contributor notes for `opencode-jev-orchestrator`. Users: see [README.md](./README.md).

## Local setup

```bash
git clone https://github.com/aaronshaf/opencode-jev-orchestrator.git
cd opencode-jev-orchestrator
npm install
npm run build
opencode plugin "$(pwd)" -g   # absolute path into ~/.config/opencode/opencode.json
```

Restart OpenCode after installing or rebuilding.

### Jev key

```bash
printf '%s\n' "$JEV_KEY" > ~/.config/opencode/opencode-jev-orchestrator.key
chmod 600 ~/.config/opencode/opencode-jev-orchestrator.key
```

Env names: `JEV_KEY`, `JEV_API_KEY`, `TYPESAFE_API_KEY`. Legacy `opencode-jev-router.key` still works.

### Optional config

```bash
cp opencode-jev-orchestrator.example.json ~/.config/opencode/opencode-jev-orchestrator.json
```

Search order (later wins): `~/.config/opencode/` → `<project>/.opencode/` → `<project>/`.
Also reads legacy `opencode-jev-router.json`.

Project files may change aliases / routing thresholds, but **cannot** remap tier models unless the *global* config sets `"allowProjectModels": true`.

## Scripts

```bash
npm run check      # typecheck + tests
npm run build
npm test
```

## Architecture sketch

- Sticky Muse parent (`chat.message` + `orchestration.parentTier`)
- Jev → `decideAction` → stay / escalate / parallel / release
- `jev_escalate` / `jev_parallel` tools → `delegate.ts` child sessions
- Children marked internal so the parent orchestrator does not rewrite them
