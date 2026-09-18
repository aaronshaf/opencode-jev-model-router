# OpenCode Go limits

**Source:** [opencode.ai/docs/go/#usage-limits](https://opencode.ai/docs/go/#usage-limits)

Per-model monthly **dollar** caps (not a shared pool). Windows: 5h = 20%, week = 50%, month = 100%.

## High-volume models (est. req / 5h)

| Model | id | /5h | $/mo |
|---|---|---:|---:|
| Muse Spark 1.3 | `muse-spark-1.3-contributor` | 45,300 | $60 |
| MiMo V2.5 | `mimo-v2.5` | 30,100 | $60 |
| DeepSeek V4.1 Flash | `deepseek-v4.1-flash` | 26,000* | $60* |
| DeepSeek V4 Flash | `deepseek-v4-flash` | 13,000 | $30 |
| LongCat-2.0 | `longcat-2.0` | 11,400 | $60 |
| GLM-5.3 Flash | `glm-5.3-flash` | 6,320 | $60 |
| Qwen3.7 Plus | `qwen3.7-plus` | 4,300 | $60 |
| GPT-5.6 Luna | `gpt-5.6-luna` | 2,050 | $15 |
| Kimi K2.7 Code | `kimi-k2.7-code` | 1,350 | $60 |
| Kimi K3 | `kimi-k3` | 110 | $15 |

\* V4.1 Flash **4× promo ends 2026-09-20** — may revert toward $15 / ~6.5k. Muse/MiMo are safer long-term high-volume picks.

Muse Spark: cheap tokens in exchange for training use; limited regions.

## DeepSeek peak / off-peak

Also: [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)

Peak (≈2× token $): Mon–Fri UTC **01:00–04:00** and **06:00–10:00**. Else off-peak (incl. weekends). Monthly $ cap unchanged — peak burns it faster.

US Mountain (UTC−6): peak ≈ 7pm–10pm and midnight–4am → daytime work is usually off-peak.

Orchestrator: during peak, try Muse/MiMo before DeepSeek. `/jev-status` shows the current period.

## Plugin defaults

| Tier | Primary | Role |
|---|---|---|
| `fast` | Muse Spark | **Sticky parent** + parallel children (training use / limited regions OK) |
| `balanced` | MiMo V2.5 | Mid tier / fallbacks |
| `strong` | Luna | Escalation child only (`jev_escalate`); fall back to Kimi/Qwen if exhausted |
| `long` | Kimi K3 (disabled) | Opt-in escalate target |

Parent never mutates onto Luna. Hard turns spawn a child with near-full context (resumes = delta only); results merge via the tool return. Strong children resume until Jev confidently says easy (or Jev is down/unsure → release). Max 3 **concurrent** children (finished parallel kids free the slot).

Orchestration defaults: `parentTier: fast`, `maxConcurrentChildren: 3`, `escalateOn: [strong, long]`.
