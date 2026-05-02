import type { ProviderThrottle } from "@/services/calendar/runtime";
import type { ThrottleProfile } from "./types";

type ProviderKey = "llm" | "gws";

interface ProviderState {
  chain: Promise<void>;
  lastFinishedAt: number;
}

export class EvalThrottle implements ProviderThrottle {
  private readonly states: Record<ProviderKey, ProviderState> = {
    llm: { chain: Promise.resolve(), lastFinishedAt: 0 },
    gws: { chain: Promise.resolve(), lastFinishedAt: 0 },
  };

  constructor(private readonly profile: ThrottleProfile) {}

  public async run<T>(
    provider: ProviderKey,
    task: () => Promise<T>,
  ): Promise<T> {
    const state = this.states[provider];
    const cooldownMs =
      provider === "llm"
        ? this.profile.llmCooldownMs
        : this.profile.gwsCooldownMs;

    let release!: () => void;
    const previous = state.chain;
    state.chain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    const elapsed = Date.now() - state.lastFinishedAt;
    if (cooldownMs > elapsed) {
      await sleep(cooldownMs - elapsed);
    }

    try {
      return await task();
    } finally {
      state.lastFinishedAt = Date.now();
      release();
    }
  }
}

export async function sleep(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, durationMs));
}
