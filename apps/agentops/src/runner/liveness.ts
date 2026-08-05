interface CoupledService {
  run(): Promise<void>;
  requestDrain(): void;
}

interface CoupledBroker {
  run(): Promise<void>;
  requestStop(): void;
}

export async function runCoupledLoops(
  service: CoupledService,
  broker: CoupledBroker,
): Promise<void> {
  const serviceRun = service.run();
  const brokerRun = broker.run();
  try {
    await Promise.race([serviceRun, brokerRun]);
  } finally {
    // Either loop owns process liveness. If one exits or rejects, stop and
    // join both so a dead execution service cannot leave a broker-only
    // container that still appears healthy.
    broker.requestStop();
    service.requestDrain();
    await Promise.allSettled([serviceRun, brokerRun]);
  }
}
