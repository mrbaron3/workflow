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

export class WebhookControlStore {
  readonly root: string;
  readonly dir: string;
  readonly file: string;
  db: WebhookControlDBType;

  constructor(root: string = process.cwd()) {
    this.root = root;
    this.dir = path.join(root, '.harness');
    this.file = path.join(this.dir, 'webhooks.json');
    this.db = this.read();
  }

  read(): WebhookControlDBType {
    if (!fs.existsSync(this.file)) return emptyWebhookControlDB();
    return WebhookControlDB.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
  }

  reload(): WebhookControlDBType {
    this.db = this.read();
    return this.db;
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const valid = WebhookControlDB.parse(this.db);
    const temp = path.join(
      this.dir,
      `.webhooks.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      fs.writeFileSync(temp, JSON.stringify(valid, null, 2) + '\n', 'utf8');
      fs.renameSync(temp, this.file);
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
    for (const row of this.db.deliveries) {
      if (row.status !== 'processing') continue;
      row.status = 'pending';
      row.lastError = 'delivery processing was interrupted; recovered on daemon start';
      row.updatedAt = nowISO();
      recovered += 1;
    }
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
      headers: input.headers,
      payload: input.payload,
      receivedAt: timestamp,
      updatedAt: timestamp,
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
    const row = this.db.deliveries.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no such webhook delivery: ${id}`);
    if (row.status !== 'pending') return null;
    row.status = 'processing';
    row.registrationId = registrationId;
    row.attempts += 1;
    row.lastError = null;
    row.ignoredReason = null;
    row.updatedAt = nowISO();
    this.save();
    return WebhookDelivery.parse(row);
  }

  markProcessed(id: string): WebhookDeliveryType {
    return this.updateDelivery(id, {
      status: 'processed',
      lastError: null,
      ignoredReason: null,
    });
  }

  markIgnored(id: string, reason: string): WebhookDeliveryType {
    return this.updateDelivery(id, {
      status: 'ignored',
      ignoredReason: reason,
      lastError: null,
    });
  }

  markFailed(id: string, error: string): WebhookDeliveryType {
    return this.updateDelivery(id, {
      status: 'failed',
      lastError: error,
      ignoredReason: null,
    });
  }

  retryDelivery(id: string): WebhookDeliveryType {
    this.reload();
    const row = this.db.deliveries.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no such webhook delivery: ${id}`);
    if (row.status !== 'failed') throw new Error(`only failed deliveries can be retried: ${id}`);
    row.status = 'pending';
    row.lastError = null;
    row.ignoredReason = null;
    row.updatedAt = nowISO();
    this.save();
    return WebhookDelivery.parse(row);
  }

  private updateDelivery(id: string, patch: Partial<WebhookDeliveryType>): WebhookDeliveryType {
    this.reload();
    const row = this.db.deliveries.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no such webhook delivery: ${id}`);
    Object.assign(row, patch, { updatedAt: nowISO() });
    const valid = WebhookDelivery.parse(row);
    Object.assign(row, valid);
    this.save();
    return valid;
  }
}
