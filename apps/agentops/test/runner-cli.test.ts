import { describe, expect, it, vi } from 'vitest';
import { runCoupledLoops } from '../src/runner/liveness.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe('runner coupled loop liveness', () => {
  it('stops and joins the broker when the execution service fails', async () => {
    const serviceRun = deferred();
    const brokerRun = deferred();
    const service = {
      run: vi.fn(() => serviceRun.promise),
      requestDrain: vi.fn(() => serviceRun.resolve()),
    };
    const broker = {
      run: vi.fn(() => brokerRun.promise),
      requestStop: vi.fn(() => brokerRun.resolve()),
    };

    const running = runCoupledLoops(service, broker);
    const failure = new Error('injected execution failure');
    serviceRun.reject(failure);

    await expect(running).rejects.toBe(failure);
    expect(service.requestDrain).toHaveBeenCalledOnce();
    expect(broker.requestStop).toHaveBeenCalledOnce();
  });

  it('stops and joins the execution service when the broker fails', async () => {
    const serviceRun = deferred();
    const brokerRun = deferred();
    const service = {
      run: vi.fn(() => serviceRun.promise),
      requestDrain: vi.fn(() => serviceRun.resolve()),
    };
    const broker = {
      run: vi.fn(() => brokerRun.promise),
      requestStop: vi.fn(() => brokerRun.resolve()),
    };

    const running = runCoupledLoops(service, broker);
    const failure = new Error('injected broker failure');
    brokerRun.reject(failure);

    await expect(running).rejects.toBe(failure);
    expect(service.requestDrain).toHaveBeenCalledOnce();
    expect(broker.requestStop).toHaveBeenCalledOnce();
  });
});
