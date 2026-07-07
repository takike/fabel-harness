export class BudgetExceededError extends Error {
  constructor(stage: string, spentUsd: number, totalUsd: number) {
    super(`fabel: budget exhausted before stage "${stage}" ($${spentUsd.toFixed(2)} spent of $${totalUsd.toFixed(2)})`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Cumulative cost tracking across every claude call in a run. The total is a hard
 * ceiling: once crossed, scheduling a new stage throws BudgetExceededError, which
 * pipelines catch to finish with a partial-results report instead of dying.
 */
export class Budget {
  private spentUsd = 0;

  constructor(readonly totalUsd?: number) {}

  record(costUsd: number): void {
    if (Number.isFinite(costUsd) && costUsd > 0) this.spentUsd += costUsd;
  }

  spent(): number {
    return this.spentUsd;
  }

  remaining(): number {
    if (this.totalUsd === undefined) return Infinity;
    return Math.max(0, this.totalUsd - this.spentUsd);
  }

  exhausted(): boolean {
    return this.remaining() <= 0;
  }

  /** Call before scheduling a stage. */
  assertAvailable(stage: string): void {
    if (this.totalUsd !== undefined && this.exhausted()) {
      throw new BudgetExceededError(stage, this.spentUsd, this.totalUsd);
    }
  }
}
