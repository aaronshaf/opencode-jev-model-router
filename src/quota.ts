import { mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ExhaustionEntry = {
  exhaustedUntil: number;
  reason: string;
  markedAt: number;
};

export type QuotaState = {
  [modelRef: string]: ExhaustionEntry;
};

const ERRORS_MAX_BYTES = 1_000_000;

/** Allowance / subscription exhaustion — not context-length or bare 429 rate limits. */
export function isQuotaError(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "number") return false;
  if (typeof err === "string") {
    return /quota|allowance|usage[\s_-]?limit/i.test(err);
  }
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    const data = o.data as Record<string, unknown> | undefined;
    const message = String(o.message ?? data?.message ?? o.name ?? "");
    return /quota|allowance|usage[\s_-]?limit/i.test(message);
  }
  return false;
}

function safeErrorSummary(err: unknown): Record<string, unknown> {
  if (err == null) return { message: "null" };
  if (typeof err !== "object") {
    return { message: String(err).slice(0, 240) };
  }
  const o = err as Record<string, unknown>;
  const data = o.data as Record<string, unknown> | undefined;
  return {
    status: o.status ?? o.statusCode,
    name: typeof o.name === "string" ? o.name : undefined,
    message: String(o.message ?? data?.message ?? "").slice(0, 240),
  };
}

export function defaultStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const root = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state");
  return join(root, "opencode-jev-router");
}

export class QuotaStore {
  private state: QuotaState = {};
  private readonly path: string;
  private readonly errorsPath: string;
  private readonly now: () => number;

  constructor(opts?: { dir?: string; now?: () => number }) {
    const dir = opts?.dir ?? defaultStateDir();
    this.path = join(dir, "quota.json");
    this.errorsPath = join(dir, "errors.jsonl");
    this.now = opts?.now ?? Date.now;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as QuotaState;
      if (parsed && typeof parsed === "object") this.state = parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.state = {};
      }
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
      renameSync(tmp, this.path);
    } catch {
      try {
        unlinkSync(`${this.path}.${process.pid}.tmp`);
      } catch {
        // ignore
      }
      // fail open
    }
  }

  isExhausted(ref: string, now = this.now()): boolean {
    const entry = this.state[ref];
    if (!entry) return false;
    if (!Number.isFinite(entry.exhaustedUntil) || entry.exhaustedUntil <= now) {
      delete this.state[ref];
      this.persist();
      return false;
    }
    return true;
  }

  mark(ref: string, untilMs: number, reason: string, now = this.now()): void {
    if (!Number.isFinite(untilMs)) return;
    this.state[ref] = {
      exhaustedUntil: untilMs,
      reason,
      markedAt: now,
    };
    this.persist();
  }

  clear(ref?: string): void {
    if (!ref) {
      this.state = {};
    } else {
      delete this.state[ref];
    }
    this.persist();
  }

  list(now = this.now()): Array<{ ref: string } & ExhaustionEntry> {
    const out: Array<{ ref: string } & ExhaustionEntry> = [];
    for (const [ref, entry] of Object.entries(this.state)) {
      if (!entry || typeof entry !== "object") continue;
      if (Number.isFinite(entry.exhaustedUntil) && entry.exhaustedUntil > now) {
        out.push({ ref, ...entry });
      }
    }
    return out.sort((a, b) => a.exhaustedUntil - b.exhaustedUntil);
  }

  appendError(record: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.errorsPath), { recursive: true });
      try {
        if (statSync(this.errorsPath).size > ERRORS_MAX_BYTES) {
          writeFileSync(this.errorsPath, "");
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const { error, ...rest } = record;
      appendFileSync(
        this.errorsPath,
        JSON.stringify({
          t: this.now(),
          ...rest,
          error: safeErrorSummary(error),
        }) + "\n",
      );
    } catch {
      // optional
    }
  }
}
