export interface DryLoopOptions {
  /** Consecutive rounds with zero new confirmed items before stopping (K). */
  dryRounds: number;
  /** Hard cap on total rounds. */
  maxRounds: number;
}

export interface DryLoopResult<T> {
  items: T[];
  rounds: number;
  /** True when the cap ended the loop while rounds were still productive. */
  hitCap: boolean;
}

/**
 * Discovery loop for unknown-size result sets: keep running rounds until K
 * consecutive rounds produce nothing new. `round` returns the NEW items it
 * confirmed this round (after dedupe/verification — empty array = dry round).
 */
export async function loopUntilDry<T>(
  round: (roundNum: number) => Promise<T[]>,
  opts: DryLoopOptions,
): Promise<DryLoopResult<T>> {
  const items: T[] = [];
  let dry = 0;
  let rounds = 0;
  while (rounds < opts.maxRounds && dry < opts.dryRounds) {
    rounds++;
    const fresh = await round(rounds);
    if (fresh.length === 0) {
      dry++;
    } else {
      dry = 0;
      items.push(...fresh);
    }
  }
  return { items, rounds, hitCap: rounds >= opts.maxRounds && dry < opts.dryRounds };
}
