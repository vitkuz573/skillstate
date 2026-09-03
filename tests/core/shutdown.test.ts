import { describe, it, expect } from 'vitest';
import { installShutdown } from '../../src/core/shutdown.js';

function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 5);
  });
}

describe('installShutdown', () => {
  it('checkpoints on SIGINT', async () => {
    let calls = 0;
    const uninstall = installShutdown(async () => {
      calls += 1;
    });
    try {
      process.emit('SIGINT', 'SIGINT');
      await nextTick();
      expect(calls).toBe(1);
    } finally {
      uninstall();
    }
  });

  it('checkpoints on SIGTERM', async () => {
    let calls = 0;
    const uninstall = installShutdown(async () => {
      calls += 1;
    });
    try {
      process.emit('SIGTERM', 'SIGTERM');
      await nextTick();
      expect(calls).toBe(1);
    } finally {
      uninstall();
    }
  });

  it('swallows async rejections (best-effort checkpoint)', async () => {
    const uninstall = installShutdown(async () => {
      throw new Error('disk gone');
    });
    try {
      process.emit('SIGINT', 'SIGINT');
      await nextTick();
    } finally {
      uninstall();
    }
  });

  it('swallows sync throws', async () => {
    const uninstall = installShutdown(() => {
      throw new Error('sync boom');
    });
    try {
      process.emit('SIGTERM', 'SIGTERM');
      await nextTick();
    } finally {
      uninstall();
    }
  });

  it('uninstall removes both listeners and is idempotent', async () => {
    let calls = 0;
    const uninstall = installShutdown(async () => {
      calls += 1;
    });
    uninstall();
    uninstall();
    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGTERM', 'SIGTERM');
    await nextTick();
    expect(calls).toBe(0);
  });
});
