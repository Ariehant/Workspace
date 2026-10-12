import { afterEach, describe, expect, it, vi } from 'vitest';
import { Notifier } from './notify/notifier';

describe('notifier scheduling', () => {
  afterEach(() => vi.useRealTimers());

  const notifier = () => {
    vi.useFakeTimers();
    const n = new Notifier({} as never, {} as never, { delayMs: 1000, maxDelayMs: 5000 });
    const run = vi.spyOn(n, 'run').mockResolvedValue();
    return { n, run };
  };

  it('reads a workspace once its changes pause', () => {
    const { n, run } = notifier();
    n.schedule('w');
    vi.advanceTimersByTime(800);
    n.schedule('w'); // still typing
    vi.advanceTimersByTime(800);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('w');
  });

  it('but no later than the longest wait after the first change', () => {
    const { n, run } = notifier();
    for (let t = 0; t < 5600; t += 700) {
      n.schedule('w');
      vi.advanceTimersByTime(700);
    }
    expect(run).toHaveBeenCalledTimes(1);
    // The next burst waits again.
    n.schedule('w');
    vi.advanceTimersByTime(999);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps workspaces apart, and runs at once when asked to', () => {
    const { n, run } = notifier();
    n.schedule('a');
    n.schedule('b', 0);
    vi.advanceTimersByTime(0);
    expect(run.mock.calls).toEqual([['b']]);
    vi.advanceTimersByTime(1000);
    expect(run.mock.calls).toEqual([['b'], ['a']]);
  });
});
