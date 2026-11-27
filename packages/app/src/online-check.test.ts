import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANSWER_WAIT_MS,
  CheckRounds,
  CheckSchedule,
  onlineSummary,
  splitOnline,
} from './online-check';

describe('CheckSchedule', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('asks 3 times a minute for 5 minutes, then stops', () => {
    const ask = vi.fn();
    const schedule = new CheckSchedule(ask);
    schedule.start();
    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(ask).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(4 * 60_000);
    expect(ask).toHaveBeenCalledTimes(15);
    expect(schedule.running).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(ask).toHaveBeenCalledTimes(15);
  });

  it('starting again gives 5 more minutes; stop stops', () => {
    const ask = vi.fn();
    const schedule = new CheckSchedule(ask);
    schedule.start();
    vi.advanceTimersByTime(4 * 60_000);
    expect(ask).toHaveBeenCalledTimes(13);
    schedule.start();
    expect(ask).toHaveBeenCalledTimes(14);
    vi.advanceTimersByTime(5 * 60_000);
    expect(ask).toHaveBeenCalledTimes(28);
    schedule.start();
    schedule.stop();
    vi.advanceTimersByTime(60_000);
    expect(ask).toHaveBeenCalledTimes(29);
  });
});

describe('CheckRounds', () => {
  it('online: answered the latest check, or the one before while answers come in', () => {
    const rounds = new CheckRounds();
    expect(rounds.online(0).size).toBe(0);
    rounds.asked('a', 0);
    expect(rounds.answered('a', 'bob')).toBe(true);
    expect(rounds.answered('a', 'bob')).toBe(false);
    expect(rounds.answered('zzz', 'gus')).toBe(false);
    expect([...rounds.online(100)]).toEqual(['bob']);

    // Bob is still shown online while the next check's answers come in…
    rounds.asked('b', 20_000);
    expect(rounds.waiting(20_001)).toBe(true);
    expect([...rounds.online(20_001)]).toEqual(['bob']);
    // …and offline once they're in without his.
    rounds.answered('b', 'cy');
    expect(rounds.waiting(20_000 + ANSWER_WAIT_MS)).toBe(false);
    expect([...rounds.online(20_000 + ANSWER_WAIT_MS)]).toEqual(['cy']);
    // A late answer to the previous check still counts for it, not the latest.
    rounds.answered('a', 'dee');
    expect([...rounds.online(30_000)]).toEqual(['cy']);
  });

  it('splits people (not me) into online and offline', () => {
    const people = [
      { id: 'me', name: 'Me', avatar: null },
      { id: 'bob', name: 'Bob', avatar: null },
      { id: 'cy', name: 'Cy', avatar: null },
    ];
    const split = splitOnline(people, 'me', new Set(['cy', 'me']));
    expect(split.online.map((p) => p.id)).toEqual(['cy']);
    expect(split.offline.map((p) => p.id)).toEqual(['bob']);
    expect(onlineSummary(1, 1)).toBe('1 online · 1 offline');
  });
});
