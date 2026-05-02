import type { AppConfig } from "@/config/schema";

export interface ProviderAvailabilityResult {
  ok: boolean;
  provider: string;
  message?: string;
}

export async function checkProviderAvailability(
  config: AppConfig,
): Promise<ProviderAvailabilityResult> {
  const provider = config.thread.provider;

  if (provider !== "ollama") {
    return { ok: true, provider };
  }

  const endpoint = "http://127.0.0.1:11434/v1/models";

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      signal: AbortSignal.timeout(1500),
    });

    if (!response.ok) {
      return {
        ok: false,
        provider,
        message: `Ollama provider check failed at ${endpoint} with HTTP ${response.status}.`,
      };
    }

    return { ok: true, provider };
  } catch (error) {
    return {
      ok: false,
      provider,
      message: `Ollama provider is not reachable at ${endpoint}. Start the Ollama app or local model gateway before running evals.`,
    };
  }
}
