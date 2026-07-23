import fs from 'node:fs';
import path from 'node:path';
import {
  WebhookControlDB,
  WebhookDelivery,
  WebhookEvent,
  WebhookRepositoryRegistration,
  WebhookRepositoryRegistrationInput,
  WebhookRepositoryRegistrationPatch,
  emptyWebhookControlDB,
  failWebhookDelivery,
  ignoreWebhookDelivery,
  processWebhookDelivery,
  retryWebhookDelivery,
  startWebhookDelivery,
  type WebhookControlDB as WebhookControlDBType,
  type WebhookDelivery as WebhookDeliveryType,
  type WebhookReceipt,
  type WebhookRepositoryRegistration as WebhookRepositoryRegistrationType,
} from './schema.js';

export interface ReceiveWebhookDeliveryInput {
  deliveryKey: string;
  event: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}
const DURABLE_HEADER_ALLOWLIST = new Set([
  'content-type',
  'user-agent',
  'x-github-delivery',
  'x-github-event',
  'x-github-hook-id',
  'x-github-hook-installation-target-id',
  'x-github-hook-installation-target-type',
]);
type MutableWebhookControlDB = Omit<WebhookControlDBType, 'deliveries'> & {
  deliveries: WebhookDeliveryType[];
};
export function durableWebhookHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) =>
      DURABLE_HEADER_ALLOWLIST.has(name.toLowerCase())),
  );
}

function nowISO(): string {
  return new Date().toISOString();
}

function repositoryFrom(payload: Record<string, unknown>): string {
  const repository = payload.repository;
  if (!repository || typeof repository !== 'object') {
    throw new Error('webhook payload must contain repository.full_name');
  }
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== 'string' || fullName.trim() === '') {
    throw new Error('webhook payload must contain repository.full_name');
  }
  return fullName.trim().toLowerCase();
}

function actionFrom(payload: Record<string, unknown>): string | null {
  return typeof payload.action === 'string' && payload.action.trim() !== ''
    ? payload.action
    : null;
}

/**
 * Early daemon builds recovered interrupted deliveries by changing only their
 * status to `pending`, leaving processing-only fields behind. Normalize that
 * persisted shape before strict validation so upgrades do not require deleting
 * the durable inbox.
 */
function normalizeLegacyControlDB(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.deliveries)) return input;
  return {
    ...record,
    deliveries: record.deliveries.map((delivery) => {
      if (!delivery || typeof delivery !== 'object') return delivery;
      const row = delivery as Record<string, unknown>;
      if (row.status !== 'pending') return delivery;
      return {
        ...row,
        registrationId: null,
        lastError: null,
        ignoredReason: null,
      };
    }),
  };
}

export class WebhookControlStore {
  readonly root: string;
  readonly dir: string;
  readonly file: string;
  private db: MutableWebhookControlDB;

  constructor(root: string = process.cwd()) {
    this.root = root;
    this.dir = path.join(root, '.harness');
    this.file = path.join(this.dir, 'webhooks.json');
    this.db = this.read();
  }

  private read(): MutableWebhookControlDB {
    const parsed = fs.existsSync(this.file)
      ? WebhookControlDB.parse(normalizeLegacyControlDB(
        JSON.parse(fs.readFileSync(this.file, 'utf8')),
      ))
      : emptyWebhookControlDB();
    return { ...parsed, deliveries: [...parsed.deliveries] };
  }

  private reload(): MutableWebhookControlDB {
    this.db = this.read();
    return this.db;
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const valid = WebhookControlDB.parse(this.db);
    const temp = path.join(
      this.dir,
      `.webhooks.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      fs.writeFileSync(temp, JSON.stringify(valid, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, this.file);
      fs.chmodSync(this.file, 0o600);
    } finally {
      if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    }
  }

  snapshot(): WebhookControlDBType {
    return WebhookControlDB.parse(this.reload());
  }

  /** A process crash cannot leave a delivery permanently stranded in `processing`. */
  recoverInterruptedDeliveries(): number {
    this.reload();
    let recovered = 0;
    this.db.deliveries = this.db.deliveries.map((row) => {
      if (row.status !== 'processing') return row;
      recovered += 1;
      return {
        ...row,
        status: 'pending',
        registrationId: null,
        lastError: null,
        ignoredReason: null,
        updatedAt: nowISO(),
      };
    });
    if (recovered > 0) this.save();
    return recovered;
  }

  private nextId(prefix: string): string {
    const next = (this.db.counters[prefix] ?? 0) + 1;
    this.db.counters[prefix] = next;
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }

  addRepository(input: unknown): WebhookRepositoryRegistrationType {
    const parsed = WebhookRepositoryRegistrationInput.parse(input);
    this.reload();
    const repository = parsed.repository.toLowerCase();
    if (this.db.repositories.some((row) => row.repository.toLowerCase() === repository)) {
      throw new Error(`repository already registered: ${repository}`);
    }
    const timestamp = nowISO();
    const row = WebhookRepositoryRegistration.parse({
      ...parsed,
      repository,
      events: [...parsed.events].sort(),
      consumers: [...parsed.consumers].sort(),
      id: this.nextId('WHREPO'),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.db.repositories.push(row);
    this.save();
    return row;
  }

  updateRepository(id: string, patch: unknown): WebhookRepositoryRegistrationType {
    const parsed = WebhookRepositoryRegistrationPatch.parse(patch);
    this.reload();
    const row = this.db.repositories.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no such repository registration: ${id}`);
    Object.assign(row, parsed, {
      ...(parsed.events ? { events: [...parsed.events].sort() } : {}),
      ...(parsed.consumers ? { consumers: [...parsed.consumers].sort() } : {}),
      updatedAt: nowISO(),
    });
    const valid = WebhookRepositoryRegistration.parse(row);
    Object.assign(row, valid);
    this.save();
    return valid;
  }

  receiveDelivery(input: ReceiveWebhookDeliveryInput): WebhookReceipt {
    const event = WebhookEvent.parse(input.event);
    const repository = repositoryFrom(input.payload);
    if (!input.deliveryKey.trim()) throw new Error('delivery key is required');
    this.reload();
    const existing = this.db.deliveries.find((row) => row.deliveryKey === input.deliveryKey);
    if (existing) {
      return { deliveryId: existing.id, duplicate: true, status: existing.status };
    }
    const timestamp = nowISO();
    const delivery = WebhookDelivery.parse({
      id: this.nextId('WHDEL'),
      deliveryKey: input.deliveryKey,
      repository,
      event,
      action: actionFrom(input.payload),
      headers: durableWebhookHeaders(input.headers),
      payload: input.payload,
      receivedAt: timestamp,
      updatedAt: timestamp,
      status: 'pending',
    });
    this.db.deliveries.push(delivery);
    this.save();
    return { deliveryId: delivery.id, duplicate: false, status: delivery.status };
  }

  getDelivery(id: string): WebhookDeliveryType | undefined {
    this.reload();
    return this.db.deliveries.find((row) => row.id === id);
  }

  startDelivery(id: string, registrationId: string): WebhookDeliveryType | null {
    this.reload();
    const index = this.db.deliveries.findIndex((candidate) => candidate.id === id);
    const row = this.db.deliveries[index];
    if (!row) throw new Error(`no such webhook delivery: ${id}`);
    if (row.status !== 'pending') return null;
    const next = startWebhookDelivery(row, registrationId, nowISO());
    this.db.deliveries[index] = next;
    this.save();
    return next;
  }

  markProcessed(id: string): WebhookDeliveryType {
    return this.transitionDelivery(id, 'processing', (row) => processWebhookDelivery(row, nowISO()));
  }

  markIgnored(id: string, reason: string): WebhookDeliveryType {
    return this.transitionDelivery(id, 'pending', (row) => ignoreWebhookDelivery(row, reason, nowISO()));
  }

  markFailed(id: string, error: string): WebhookDeliveryType {
    return this.transitionDelivery(id, 'processing', (row) => failWebhookDelivery(row, error, nowISO()));
  }

  retryDelivery(id: string): WebhookDeliveryType {
    this.reload();
    const index = this.db.deliveries.findIndex((candidate) => candidate.id === id);
    const row = this.db.deliveries[index];
    if (!row) throw new Error(`no such webhook delivery: ${id}`);
    if (row.status !== 'failed') throw new Error(`only failed deliveries can be retried: ${id}`);
    const next = retryWebhookDelivery(row, nowISO());
    this.db.deliveries[index] = next;
    this.save();
    return next;
  }

  private transitionDelivery<S extends WebhookDeliveryType['status']>(
    id: string,
    expected: S,
    transition: (row: Extract<WebhookDeliveryType, { status: S }>) => WebhookDeliveryType,
  ): WebhookDeliveryType {
    this.reload();
    const index = this.db.deliveries.findIndex((candidate) => candidate.id === id);
    const row = this.db.deliveries[index];
    if (!row) throw new Error(`no such webhook delivery: ${id}`);
    if (row.status !== expected) {
      throw new Error(`delivery ${id} must be ${expected}, not ${row.status}`);
    }
    const valid = transition(row as Extract<WebhookDeliveryType, { status: S }>);
    this.db.deliveries[index] = valid;
    this.save();
    return valid;
  }
}
