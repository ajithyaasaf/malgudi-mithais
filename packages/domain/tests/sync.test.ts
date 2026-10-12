import { describe, it, expect } from 'vitest';
import { 
  ingestSyncEvent, 
  ServerDatabaseState, 
  ServerSyncEvent 
} from '../src/sync.js';
import { CanonicalSaleAggregate } from '@malgudi/contracts';

describe('Server Synchronization & Outbox Ingestion Safety', () => {
  function createFreshServerDb(): ServerDatabaseState {
    return {
      committedEvents: new Map(),
      committedAggregates: new Map(),
      outOfOrderBuffer: new Map(),
    };
  }

  const sampleSaleAggregate: CanonicalSaleAggregate = {
    version: '2.9',
    sale: {
      id: '0192a543-0001-7000-8000-000000000001',
      invoice_number: 'IB1/2627/000142',
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
      payment_status: 'UNSETTLED_PENDING', // Payment is unsettled pending bank confirmation
      sync_status: 'SYNC_PENDING',
      created_at: '2026-10-10T10:00:00Z',
    },
    items: [
      {
        id: 'item_1',
        product_id: 'prod_mysore_pak',
        quantity_input: 375000,
        pricing_unit: 'PER_KG',
        weight_input_source: 'SCALE_AUTO',
        unit_price_paise: 68000,
        taxable_paise: 24286,
        cgst_paise: 607,
        sgst_paise: 607,
        igst_paise: 0,
        total_tax_paise: 1214,
        gross_paise: 25500,
        stock_deduction_delta: -375000,
        stock_unit: 'MG',
      },
    ],
    payments: [],
    cash_movements: [],
    stock_movements: [],
    outbox: {
      event_id: 'evt_sync_001',
      aggregate_type: 'SALE',
      aggregate_id: '0192a543-0001-7000-8000-000000000001',
      event_seq: 1,
      payload_hash: 'hash_abc123',
      created_at: '2026-10-10T10:00:00Z',
    },
    audit: {
      id: 'aud_1',
      action: 'SALE_FINALIZED',
      entity_type: 'SALE',
      entity_id: '0192a543-0001-7000-8000-000000000001',
      actor_id: 'cashier_01',
      created_at: '2026-10-10T10:00:00Z',
    },
  };

  const sampleSyncEvent: ServerSyncEvent = {
    event_id: 'evt_sync_001',
    aggregate_type: 'SALE',
    aggregate_id: '0192a543-0001-7000-8000-000000000001',
    payload_json: JSON.stringify(sampleSaleAggregate),
    payload_hash: 'hash_abc123',
    created_at: '2026-10-10T10:00:00Z',
  };

  it('Server commits durable data and returns acknowledgment', () => {
    const serverDb = createFreshServerDb();

    const result = ingestSyncEvent(serverDb, sampleSyncEvent, sampleSaleAggregate);
    expect(result.status).toBe('COMMITTED_ACK');
    expect(result.acknowledged).toBe(true);

    // Verify durable storage
    expect(serverDb.committedEvents.has('evt_sync_001')).toBe(true);
    expect(serverDb.committedAggregates.has(sampleSaleAggregate.sale.id)).toBe(true);

    // Crucial Invariant: Server sync acknowledgment does NOT alter payment_status!
    const stored = serverDb.committedAggregates.get(sampleSaleAggregate.sale.id)!;
    expect(stored.sale.payment_status).toBe('UNSETTLED_PENDING');
  });

  it('Handles lost ACK network drop followed by client retry (Idempotent ACK)', () => {
    const serverDb = createFreshServerDb();

    // First attempt: Server commits, but network drops before ACK reaches client
    const droppedAttempt = ingestSyncEvent(serverDb, sampleSyncEvent, sampleSaleAggregate, true);
    expect(droppedAttempt.acknowledged).toBe(false); // Client experienced network drop

    // Verify server DID commit durably
    expect(serverDb.committedEvents.size).toBe(1);

    // Client restarts or retries sending the same event
    const retryAttempt = ingestSyncEvent(serverDb, sampleSyncEvent, sampleSaleAggregate, false);
    expect(retryAttempt.status).toBe('ALREADY_COMMITTED_IDEMPOTENT_ACK');
    expect(retryAttempt.acknowledged).toBe(true);
    expect(serverDb.committedEvents.size).toBe(1); // Zero duplicate rows!
  });

  it('Rejects payload mutation when same event ID has altered content', () => {
    const serverDb = createFreshServerDb();

    // Commit original
    ingestSyncEvent(serverDb, sampleSyncEvent, sampleSaleAggregate);

    // Client attempts to send an event with same ID but modified payload
    const mutatedEvent: ServerSyncEvent = {
      ...sampleSyncEvent,
      payload_hash: 'hash_mutated_456', // Conflict!
    };

    const conflictResult = ingestSyncEvent(serverDb, mutatedEvent, sampleSaleAggregate);
    expect(conflictResult.status).toBe('REJECTED_PAYLOAD_MUTATION');
    expect(conflictResult.acknowledged).toBe(false);
    expect(conflictResult.message).toContain('Conflict');
  });

  it('Buffers out-of-order child events until parent aggregate arrives', () => {
    const serverDb = createFreshServerDb();

    const parentId = '0192a543-0001-7000-8000-000000000001';
    const childEvent: ServerSyncEvent = {
      event_id: 'evt_child_return_001',
      aggregate_type: 'RETURN',
      aggregate_id: '0192a543-0002-7000-8000-000000000002',
      parent_id: parentId, // Child refers to parent sale
      payload_json: '{}',
      payload_hash: 'hash_child_001',
      created_at: '2026-10-10T10:05:00Z',
    };

    // Child arrives FIRST before parent sale
    const childResult = ingestSyncEvent(serverDb, childEvent, sampleSaleAggregate);
    expect(childResult.status).toBe('BUFFERED_WAITING_PARENT');
    expect(childResult.acknowledged).toBe(false);
    expect(serverDb.outOfOrderBuffer.has(parentId)).toBe(true);

    // Parent sale arrives NEXT
    const parentResult = ingestSyncEvent(serverDb, sampleSyncEvent, sampleSaleAggregate);
    expect(parentResult.status).toBe('COMMITTED_ACK');
    expect(parentResult.acknowledged).toBe(true);

    // Buffered child must now be automatically committed
    expect(serverDb.outOfOrderBuffer.has(parentId)).toBe(false);
    expect(serverDb.committedEvents.has('evt_child_return_001')).toBe(true);
  });
});
