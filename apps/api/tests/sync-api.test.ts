import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DurableSyncServer,
  ServerSyncEvent,
  PaymentReconciliationEvent,
  createSyncHttpServer,
  IngestionResponse,
} from '../src/index.js';
import { CanonicalSaleAggregate } from '@malgudi/contracts';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

describe('Central Cloud API — Durable Synchronization & Process Restart Persistence', () => {
  let serverInstance: DurableSyncServer;
  let httpServer: http.Server;
  let baseUrl: string;
  const testDbFile = path.join(process.cwd(), 'test_sync_persistence.db');

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer malgudi_sync_secret_token_2026',
    'X-Terminal-Id': 'T1',
    'X-Branch-Id': 'IB',
  };

  const createSampleAggregate = (
    id: string,
    paymentStatus: 'UNSETTLED_PENDING' | 'SETTLED' = 'SETTLED'
  ): CanonicalSaleAggregate => ({
    version: '2.9',
    sale: {
      id,
      invoice_number: `IB1/2627/${id.substring(0, 6)}`,
      branch_id: 'IB',
      counter_id: 'C1',
      terminal_id: 'T1',
      session_id: 'sess_01',
      business_date: '2026-10-10',
      tax_policy_version: '2026.1-TN',
      subtotal_taxable_paise: 24286,
      total_cgst_paise: 607,
      total_sgst_paise: 607,
      total_igst_paise: 0,
      round_off_paise: 0,
      net_payable_paise: 25500,
      sale_status: 'COMPLETED',
      payment_status: paymentStatus,
      sync_status: 'SYNC_PENDING',
      created_at: '2026-10-10T10:00:00Z',
    },
    items: [],
    payments: [],
    cash_movements: [],
    stock_movements: [],
    outbox: {
      event_id: `evt_${id}`,
      aggregate_type: 'SALE',
      aggregate_id: id,
      event_seq: 1,
      payload_hash: `hash_${id}_original`,
      created_at: '2026-10-10T10:00:00Z',
    },
    audit: {
      id: `aud_${id}`,
      action: 'SALE_FINALIZED',
      entity_type: 'SALE',
      entity_id: id,
      actor_id: 'cashier_01',
      created_at: '2026-10-10T10:00:00Z',
    },
  });

  const startHttpServer = async (server: DurableSyncServer): Promise<void> => {
    return new Promise((resolve) => {
      httpServer = createSyncHttpServer(server);
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  };

  const stopHttpServer = async (): Promise<void> => {
    return new Promise((resolve) => {
      if (httpServer) {
        httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  };

  beforeEach(async () => {
    // Clean up old db file if exists
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(testDbFile + suffix)) {
        try { fs.unlinkSync(testDbFile + suffix); } catch {}
      }
    }
    serverInstance = new DurableSyncServer(testDbFile);
    await startHttpServer(serverInstance);
  });

  afterEach(async () => {
    await stopHttpServer();
    if (serverInstance) {
      serverInstance.close();
    }
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(testDbFile + suffix)) {
        try { fs.unlinkSync(testDbFile + suffix); } catch {}
      }
    }
  });

  it('0. Rejects requests with missing or invalid authentication headers (Security Boundary)', async () => {
    const aggregate = createSampleAggregate('sale_auth_test');
    const event: ServerSyncEvent = {
      event_id: 'evt_auth_test',
      aggregate_type: 'SALE',
      aggregate_id: aggregate.sale.id,
      payload_json: JSON.stringify(aggregate),
      payload_hash: 'hash_auth_test',
      created_at: '2026-10-10T10:00:00Z',
    };

    // Missing token
    const resNoAuth = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, aggregate }),
    });
    expect(resNoAuth.status).toBe(401);

    // Invalid token
    const resBadToken = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: { ...authHeaders, Authorization: 'Bearer WRONG_SECRET' },
      body: JSON.stringify({ event, aggregate }),
    });
    expect(resBadToken.status).toBe(401);
  });

  it('1. Event persisted to disk BEFORE HTTP acknowledgment is sent', async () => {
    const aggregate = createSampleAggregate('sale_commit_first');
    const event: ServerSyncEvent = {
      event_id: 'evt_commit_first',
      aggregate_type: 'SALE',
      aggregate_id: aggregate.sale.id,
      payload_json: JSON.stringify(aggregate),
      payload_hash: 'hash_commit_first',
      created_at: '2026-10-10T10:00:00Z',
    };

    const response = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event, aggregate }),
    });

    expect(response.status).toBe(200);
    const body: IngestionResponse = await response.json();
    expect(body.acknowledged).toBe(true);
    expect(body.persistedDurable).toBe(true);
    expect(body.status).toBe('COMMITTED_ACK');

    // Verify stored on disk
    expect(serverInstance.hasAggregate(aggregate.sale.id)).toBe(true);
    expect(serverInstance.hasEvent(event.event_id)).toBe(true);
  });

  it('2. Server restart after commit: all acknowledged records survive and remain queryable', async () => {
    const aggregate = createSampleAggregate('sale_restart_test');
    const event: ServerSyncEvent = {
      event_id: 'evt_restart_test',
      aggregate_type: 'SALE',
      aggregate_id: aggregate.sale.id,
      payload_json: JSON.stringify(aggregate),
      payload_hash: 'hash_restart_test',
      created_at: '2026-10-10T10:00:00Z',
    };

    // 1. Commit event via HTTP
    const res1 = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event, aggregate }),
    });
    expect(res1.status).toBe(200);

    // 2. Simulate complete process crash / shutdown
    await stopHttpServer();
    serverInstance.close();

    // 3. Restart server pointing to the exact same database file
    const restartedServer = new DurableSyncServer(testDbFile);
    await startHttpServer(restartedServer);
    serverInstance = restartedServer;

    // 4. Verify data survived process restart
    expect(restartedServer.hasEvent('evt_restart_test')).toBe(true);
    expect(restartedServer.hasAggregate('sale_restart_test')).toBe(true);
    const savedEvent = restartedServer.getCommittedEvent('evt_restart_test');
    expect(savedEvent?.payload_hash).toBe('hash_restart_test');

    // 5. Subsequent retry over HTTP receives idempotent ACK
    const resRetry = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event, aggregate }),
    });
    expect(resRetry.status).toBe(200);
    const retryBody: IngestionResponse = await resRetry.json();
    expect(retryBody.status).toBe('ALREADY_COMMITTED_IDEMPOTENT_ACK');
    expect(retryBody.acknowledged).toBe(true);
    expect(restartedServer.committedEventsCount).toBe(1);
  });

  it('3. Lost acknowledgment followed by client retry (idempotent recovery)', async () => {
    const aggregate = createSampleAggregate('sale_lost_ack');
    const event: ServerSyncEvent = {
      event_id: 'evt_lost_ack',
      aggregate_type: 'SALE',
      aggregate_id: aggregate.sale.id,
      payload_json: JSON.stringify(aggregate),
      payload_hash: 'hash_lost_ack',
      created_at: '2026-10-10T10:00:00Z',
    };

    // First attempt: Server committed data, but network drops ACK
    const firstAttempt = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event, aggregate, simulateLostNetworkAck: true }),
    });
    const firstBody: IngestionResponse = await firstAttempt.json();
    expect(firstBody.acknowledged).toBe(false);
    expect(firstBody.persistedDurable).toBe(true);
    expect(serverInstance.hasAggregate(aggregate.sale.id)).toBe(true);

    // Client restarts, retries unacknowledged outbox event
    const retryAttempt = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event, aggregate }),
    });
    const retryBody: IngestionResponse = await retryAttempt.json();
    expect(retryBody.status).toBe('ALREADY_COMMITTED_IDEMPOTENT_ACK');
    expect(retryBody.acknowledged).toBe(true);
    expect(serverInstance.committedAggregatesCount).toBe(1);
  });

  it('4. Concurrent duplicate event submissions are safely handled without duplication', async () => {
    const aggregate = createSampleAggregate('sale_concurrent');
    const event: ServerSyncEvent = {
      event_id: 'evt_concurrent',
      aggregate_type: 'SALE',
      aggregate_id: aggregate.sale.id,
      payload_json: JSON.stringify(aggregate),
      payload_hash: 'hash_concurrent',
      created_at: '2026-10-10T10:00:00Z',
    };

    // Send 5 identical requests concurrently
    const responses = await Promise.all([
      fetch(`${baseUrl}/api/v1/sync/events`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ event, aggregate }) }),
      fetch(`${baseUrl}/api/v1/sync/events`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ event, aggregate }) }),
      fetch(`${baseUrl}/api/v1/sync/events`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ event, aggregate }) }),
      fetch(`${baseUrl}/api/v1/sync/events`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ event, aggregate }) }),
      fetch(`${baseUrl}/api/v1/sync/events`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ event, aggregate }) }),
    ]);

    for (const r of responses) {
      expect(r.status).toBe(200);
      const b: IngestionResponse = await r.json();
      expect(b.acknowledged).toBe(true);
    }

    // Exactly one row must exist
    expect(serverInstance.committedEventsCount).toBe(1);
    expect(serverInstance.committedAggregatesCount).toBe(1);
  });

  it('5. Rejects with 409 Conflict when same event ID arrives with modified payload', async () => {
    const aggregate = createSampleAggregate('sale_mutation');
    const eventOriginal: ServerSyncEvent = {
      event_id: 'evt_mutation',
      aggregate_type: 'SALE',
      aggregate_id: aggregate.sale.id,
      payload_json: JSON.stringify(aggregate),
      payload_hash: 'hash_original_ok',
      created_at: '2026-10-10T10:00:00Z',
    };

    // Original event committed
    const res1 = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event: eventOriginal, aggregate }),
    });
    expect(res1.status).toBe(200);

    // Tampered payload with modified hash
    const eventTampered: ServerSyncEvent = {
      ...eventOriginal,
      payload_hash: 'hash_MODIFIED_TAMPERED',
    };

    const res2 = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event: eventTampered, aggregate }),
    });
    expect(res2.status).toBe(409);
    const body2: IngestionResponse = await res2.json();
    expect(body2.status).toBe('REJECTED_PAYLOAD_MUTATION');
    expect(body2.acknowledged).toBe(false);
  });

  it('6. Buffers out-of-order child events and flushes them when parent arrives', async () => {
    const parentAggregate = createSampleAggregate('sale_parent_01');
    const parentEvent: ServerSyncEvent = {
      event_id: 'evt_parent_01',
      aggregate_type: 'SALE',
      aggregate_id: parentAggregate.sale.id,
      payload_json: JSON.stringify(parentAggregate),
      payload_hash: 'hash_parent_01',
      created_at: '2026-10-10T10:00:00Z',
    };

    const childAggregate = createSampleAggregate('sale_return_child_01');
    const childEvent: ServerSyncEvent = {
      event_id: 'evt_return_child_01',
      aggregate_type: 'RETURN',
      aggregate_id: childAggregate.sale.id,
      parent_id: parentAggregate.sale.id,
      payload_json: JSON.stringify(childAggregate),
      payload_hash: 'hash_return_child_01',
      created_at: '2026-10-10T10:05:00Z',
    };

    // 1. Child arrives before parent -> Buffers
    const resChild = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event: childEvent, aggregate: childAggregate }),
    });
    const childBody: IngestionResponse = await resChild.json();
    expect(childBody.status).toBe('BUFFERED_WAITING_PARENT');
    expect(childBody.acknowledged).toBe(false);
    expect(serverInstance.hasAggregate(childAggregate.sale.id)).toBe(false);

    // 2. Parent arrives -> Commits parent and automatically flushes buffered child
    const resParent = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event: parentEvent, aggregate: parentAggregate }),
    });
    const parentBody: IngestionResponse = await resParent.json();
    expect(parentBody.status).toBe('COMMITTED_ACK');
    expect(parentBody.acknowledged).toBe(true);

    // Both parent and child must now be committed
    expect(serverInstance.hasAggregate(parentAggregate.sale.id)).toBe(true);
    expect(serverInstance.hasAggregate(childAggregate.sale.id)).toBe(true);
    expect(serverInstance.committedAggregatesCount).toBe(2);
  });

  it('7. Replays events from restored client backup without duplicating aggregates', async () => {
    const agg1 = createSampleAggregate('sale_replay_1');
    const evt1: ServerSyncEvent = {
      event_id: 'evt_replay_1',
      aggregate_type: 'SALE',
      aggregate_id: agg1.sale.id,
      payload_json: JSON.stringify(agg1),
      payload_hash: 'hash_replay_1',
      created_at: '2026-10-10T10:00:00Z',
    };
    const agg2 = createSampleAggregate('sale_replay_2');
    const evt2: ServerSyncEvent = {
      event_id: 'evt_replay_2',
      aggregate_type: 'SALE',
      aggregate_id: agg2.sale.id,
      payload_json: JSON.stringify(agg2),
      payload_hash: 'hash_replay_2',
      created_at: '2026-10-10T10:01:00Z',
    };

    // 1. Commit evt1 initially
    await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event: evt1, aggregate: agg1 }),
    });

    // 2. Client restores backup containing both evt1 and newly created evt2
    const replayRes = await fetch(`${baseUrl}/api/v1/sync/replay`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        events: [
          { event: evt1, aggregate: agg1 },
          { event: evt2, aggregate: agg2 },
        ],
      }),
    });

    expect(replayRes.status).toBe(200);
    const replayBody = await replayRes.json();
    expect(replayBody.totalReplayed).toBe(2);
    expect(replayBody.alreadyCommittedCount).toBe(1);
    expect(replayBody.newlyCommittedCount).toBe(1);
    expect(serverInstance.committedAggregatesCount).toBe(2);
  });

  it('8. Duplicate and out-of-order payment webhook events are handled deterministically', async () => {
    const webhookSeq1: PaymentReconciliationEvent = {
      event_id: 'rec_seq_1',
      sale_id: 'sale_recon_99',
      payment_id: 'pay_upi_99',
      gateway_outcome: 'SUCCESS',
      sequence_number: 1,
      occurred_at: '2026-10-10T10:00:00Z',
    };

    const webhookSeq2: PaymentReconciliationEvent = {
      event_id: 'rec_seq_2',
      sale_id: 'sale_recon_99',
      payment_id: 'pay_upi_99',
      gateway_outcome: 'FAILED',
      sequence_number: 2,
      occurred_at: '2026-10-10T10:01:00Z',
    };

    // 1. Sequence 2 arrives FIRST (out-of-order delivery)
    const resSeq2 = await fetch(`${baseUrl}/api/v1/sync/reconcile-payment`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(webhookSeq2),
    });
    const bodySeq2 = await resSeq2.json();
    expect(bodySeq2.isDuplicate).toBe(false);
    expect(bodySeq2.currentOutcome).toBe('FAILED');

    // 2. Older sequence 1 arrives LATER -> Ignored as superseded
    const resSeq1 = await fetch(`${baseUrl}/api/v1/sync/reconcile-payment`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(webhookSeq1),
    });
    const bodySeq1 = await resSeq1.json();
    expect(bodySeq1.isDuplicate).toBe(true);
    expect(bodySeq1.currentOutcome).toBe('FAILED'); // Preserves outcome from higher seq (2)

    // 3. Exact duplicate of seq 2 arrives -> Recognized as duplicate
    const resSeq2Dup = await fetch(`${baseUrl}/api/v1/sync/reconcile-payment`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(webhookSeq2),
    });
    const bodySeq2Dup = await resSeq2Dup.json();
    expect(bodySeq2Dup.isDuplicate).toBe(true);
    expect(bodySeq2Dup.currentOutcome).toBe('FAILED');
  });

  it('9. Sync acknowledgment NEVER marks an unsettled payment as settled', async () => {
    const aggregate = createSampleAggregate('sale_unsettled_sync', 'UNSETTLED_PENDING');
    const event: ServerSyncEvent = {
      event_id: 'evt_unsettled_sync',
      aggregate_type: 'SALE',
      aggregate_id: aggregate.sale.id,
      payload_json: JSON.stringify(aggregate),
      payload_hash: 'hash_unsettled_sync',
      created_at: '2026-10-10T10:00:00Z',
    };

    const res = await fetch(`${baseUrl}/api/v1/sync/events`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ event, aggregate }),
    });

    const body: IngestionResponse = await res.json();
    expect(body.acknowledged).toBe(true);

    // Verify stored aggregate still preserves UNSETTLED_PENDING
    const persisted = serverInstance.getCommittedAggregate('sale_unsettled_sync');
    expect(persisted?.sale.payment_status).toBe('UNSETTLED_PENDING');
  });
});
