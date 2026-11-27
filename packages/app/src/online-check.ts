/**
 * The online check of a shared page: who of the people with access is there now.
 *
 * - This computer asks through the server (`OnlineCheckPlatform.ping`), and the connected
 *   devices of everyone else who may read the page answer at once.
 * - After sharing, or on opening a shared page, it asks every 20 s (3 times a minute) for
 *   5 minutes, then stops. **Ping** asks again by hand; the people asked see who's asking.
 * - Someone is online when they answered the latest check (or, for its first 5 s, the one
 *   before: answers take a moment), or have the page open now. Everyone else with access
 *   is offline.
 */

export const CHECK_EVERY_MS = 20_000;
export const CHECK_FOR_MS = 5 * 60_000;
/** How long the answers to a check take to come in. */
export const ANSWER_WAIT_MS = 5_000;

/**
 * Calls `ask` now, then every `everyMs` until `forMs` has passed since the last `start`
 * (asks at 0, 20, … 280 s: 15 in 5 minutes).
 */
export class CheckSchedule {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private until = 0;

  constructor(
    private readonly ask: () => void,
    private readonly everyMs = CHECK_EVERY_MS,
    private readonly forMs = CHECK_FOR_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start, or start over (5 more minutes from now). */
  start(): void {
    this.stop();
    this.until = this.now() + this.forMs;
    this.tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  private tick(): void {
    this.ask();
    const next = this.now() + this.everyMs;
    this.timer = next < this.until ? setTimeout(() => this.tick(), this.everyMs) : null;
  }
}

interface Round {
  nonce: string;
  at: number;
  answered: Set<string>;
}

/** The checks this computer made for a page, and who answered them. */
export class CheckRounds {
  private current: Round | null = null;
  private previous: Round | null = null;

  /** A check went out. */
  asked(nonce: string, at: number): void {
    this.previous = this.current;
    this.current = { nonce, at, answered: new Set() };
  }

  /** Someone answered; false if it isn't one of the latest two checks'. */
  answered(nonce: string, userId: string): boolean {
    const round = [this.current, this.previous].find((r) => r?.nonce === nonce);
    if (!round || round.answered.has(userId)) return false;
    round.answered.add(userId);
    return true;
  }

  /** When the latest check went out (null: none yet). */
  get lastAskedAt(): number | null {
    return this.current?.at ?? null;
  }

  /** Who's online at `now`, from the answers. */
  online(now: number): Set<string> {
    if (!this.current) return new Set();
    const online = new Set(this.current.answered);
    if (this.previous && now - this.current.at < ANSWER_WAIT_MS) {
      for (const id of this.previous.answered) online.add(id);
    }
    return online;
  }

  /** Whether answers to the latest check may still come in. */
  waiting(now: number): boolean {
    return !!this.current && now - this.current.at < ANSWER_WAIT_MS;
  }
}

export interface Person {
  id: string;
  name: string;
  avatar: string | null;
}

/** Everyone else with access, split by who's there (in the people list's order). */
export function splitOnline(
  people: Person[],
  me: string,
  online: Set<string>,
): { online: Person[]; offline: Person[] } {
  const others = people.filter((p) => p.id !== me);
  return {
    online: others.filter((p) => online.has(p.id)),
    offline: others.filter((p) => !online.has(p.id)),
  };
}

/** "2 online · 1 offline". */
export function onlineSummary(online: number, offline: number): string {
  return `${online} online · ${offline} offline`;
}
