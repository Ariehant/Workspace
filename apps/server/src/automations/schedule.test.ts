/** When the automations follower reads a workspace's changes: after a pause, or at the cap. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '../context';
import { Automations } from './runner';

function follower(delayMs: number) {
  const ctx = { jobs: { register: () => {} } } as unknown as ServerContext;
  const automations = new Automations(ctx, { delayMs });
  const follow = vi.spyOn(automations, 'follow').mockResolvedValue();
  return { automations, follow };
}

describe('automations: reading changes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for the changes to pause', () => {
    const { automations, follow } = follower(1000);
    automations.schedule('w');
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(900);
      automations.schedule('w');
    }
    expect(follow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(follow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(follow).toHaveBeenCalledWith('w');
  });

  it('reads a workspace that never pauses 5 times the wait after its first change', () => {
    const { automations, follow } = follower(1000);
    automations.schedule('w');
    // A change every half second: at 4.5 s, still waiting; at 5 s, read.
    for (let i = 0; i < 9; i++) {
      vi.advanceTimersByTime(500);
      automations.schedule('w');
    }
    vi.advanceTimersByTime(499);
    expect(follow).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(follow).toHaveBeenCalledTimes(1);
    // The next change starts a new wait.
    automations.schedule('w');
    vi.advanceTimersByTime(999);
    expect(follow).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(follow).toHaveBeenCalledTimes(2);
  });

  it('workspaces wait on their own; catching up at start reads now', () => {
    const { automations, follow } = follower(1000);
    automations.schedule('a');
    vi.advanceTimersByTime(600);
    automations.schedule('b');
    vi.advanceTimersByTime(400);
    expect(follow.mock.calls).toEqual([['a']]);
    vi.advanceTimersByTime(600);
    expect(follow.mock.calls).toEqual([['a'], ['b']]);
    automations.schedule('c', 0);
    vi.advanceTimersByTime(0);
    expect(follow.mock.calls.at(-1)).toEqual(['c']);
  });
});
