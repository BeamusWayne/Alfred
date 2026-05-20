export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-7": { inputPerMillion: 15, outputPerMillion: 75, cacheReadPerMillion: 1.50, cacheWritePerMillion: 18.75 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.30, cacheWritePerMillion: 3.75 },
  "claude-haiku-4-5": { inputPerMillion: 0.80, outputPerMillion: 4, cacheReadPerMillion: 0.08, cacheWritePerMillion: 1.00 },
};

const DEFAULT_PRICING: ModelPricing = MODEL_PRICING["claude-sonnet-4-6"];

function getPricing(model: string): ModelPricing {
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.includes(key) || key.includes(model)) return MODEL_PRICING[key];
  }
  return DEFAULT_PRICING;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalCost: number;
}

export class CostTracker {
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheWriteTokens = 0;
  private totalCost = 0;

  addUsage(model: string, usage: Usage): void {
    const pricing = getPricing(model);
    const costDelta =
      (usage.inputTokens * pricing.inputPerMillion) / 1_000_000 +
      (usage.outputTokens * pricing.outputPerMillion) / 1_000_000 +
      (usage.cacheReadTokens * pricing.cacheReadPerMillion) / 1_000_000 +
      (usage.cacheWriteTokens * pricing.cacheWritePerMillion) / 1_000_000;

    this.totalInputTokens += usage.inputTokens;
    this.totalOutputTokens += usage.outputTokens;
    this.totalCacheReadTokens += usage.cacheReadTokens;
    this.totalCacheWriteTokens += usage.cacheWriteTokens;
    this.totalCost += costDelta;

    _sessionInput += usage.inputTokens;
    _sessionOutput += usage.outputTokens;
    _sessionCacheRead += usage.cacheReadTokens;
    _sessionCacheWrite += usage.cacheWriteTokens;
    _sessionCost += costDelta;
  }

  getCosts(): CostSummary {
    return {
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      totalCost: Math.round(this.totalCost * 100) / 100,
    };
  }
}

let _sessionInput = 0;
let _sessionOutput = 0;
let _sessionCacheRead = 0;
let _sessionCacheWrite = 0;
let _sessionCost = 0;

export function getSessionCosts(): CostSummary {
  return {
    totalInputTokens: _sessionInput,
    totalOutputTokens: _sessionOutput,
    totalCacheReadTokens: _sessionCacheRead,
    totalCacheWriteTokens: _sessionCacheWrite,
    totalCost: Math.round(_sessionCost * 100) / 100,
  };
}

export function resetCostTracker(): void {
  _sessionInput = 0;
  _sessionOutput = 0;
  _sessionCacheRead = 0;
  _sessionCacheWrite = 0;
  _sessionCost = 0;
}

export function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}
