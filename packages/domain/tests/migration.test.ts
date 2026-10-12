import { describe, it, expect } from 'vitest';
import { CanonicalSaleAggregate } from '@malgudi/contracts';
import {
  createMigrationBundle,
  verifyMigrationBundle,
  advanceMigrationCheckpoint,
  executeMigrationIngestion,
  transitionLocalSyncStatus,
  MigrationCheckpoint,
} from '../src/migration.js';
import { ServerDatabaseState } from '../src/sync.js';
import { computeAggregateSha256 } from '../src/aggregate.js';

describe('Local Data Ownership & Future Cloud Migration Engine', () => {
  const createTestAggregate = (
    id: string,
    invoiceNum: string,
    eventSeq: number = 1,
    netPayablePaise: number = 25500,
    cashAmountPaise: number = 15500
  ): CanonicalSaleAggregate => {
    const raw: CanonicalSaleAggregate = {
      version: '2.9',
      sale: {
        id,
        invoice_number: invoiceNum,
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
        net_payable_paise: netPayablePaise,
        sale_status: 'COMPLETED',
        payment_status: 'SETTLED',
        sync_status: 'LOCAL_DURABLE',
        created_at: '2026-10-10T10:00:00.000Z',
      },
      items: [
        {
          id: `item_${id}`,
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
      payments: [
        {
          id: `pay_cash_${id}`,
          payment_method: 'CASH',
          allocated_amount_paise: cashAmountPaise,
          tendered_paise: 20000,
          change_returned_paise: 4500,
          net_amount_paise: cashAmountPaise,
          outcome: 'SUCCESS',
        },
        {
          id: `pay_upi_${id}`,
          payment_method: 'UPI_MANUAL_RECORDED',
          allocated_amount_paise: netPayablePaise - cashAmountPaise,
          tendered_paise: netPayablePaise - cashAmountPaise,
          change_returned_paise: 0,
          net_amount_paise: netPayablePaise - cashAmountPaise,
          outcome: 'SUCCESS',
        },
      ],
      cash_movements: [
        {
          id: `cm_${id}`,
          session_id: 'sess_01',
          branch_id: 'IB',
          movement_type: 'CASH_SALE',
          amount_paise: cashAmountPaise,
          direction: 'IN',
          reference_id: id,
          created_at: '2026-10-10T10:00:00.000Z',
        },
      ],
      stock_movements: [
        {
          id: `sm_${id}`,
          branch_id: 'IB',
          product_id: 'prod_mysore_pak',
          movement_type: 'SALE_DEDUCTION',
          quantity_delta: -375000,
          unit: 'MG',
          reference_id: id,
          created_at: '2026-10-10T10:00:00.000Z',
        },
      ],
      outbox: {
        event_id: `evt_${id}`,
        aggregate_type: 'SALE',
        aggregate_id: id,
        event_seq: eventSeq,
        payload_hash: '',
        created_at: '2026-10-10T10:00:00.000Z',
      },
      audit: {
        id: `aud_${id}`,
        action: 'SALE_FINALIZED',
        entity_type: 'SALE',
        entity_id: id,
        actor_id: 'cashier_01',
        created_at: '2026-10-10T10:00:00.000Z',
      },
    };
    raw.outbox.payload_hash = computeAggregateSha256(raw);
    return raw;
  };

  it('1. Generates a valid migration bundle with cryptographic checksum and metadata', () => {
    const agg1 = createTestAggregate('sale_001', 'IB1/2627/000101', 1);
    const agg2 = createTestAggregate('sale_002', 'IB1/2627/000102', 2);

    const bundle = createMigrationBundle('T1', 'IB', 1, [agg2, agg1], '2026-10-10T11:00:00.000Z');

    expect(bundle.metadata.source_terminal_id).toBe('T1');
    expect(bundle.metadata.source_branch_id).toBe('IB');
    expect(bundle.metadata.schema_version).toBe(1);
    expect(bundle.metadata.total_records).toBe(2);
    expect(bundle.metadata.sha256_checksum).toBeTruthy();
    // Aggregates must be deterministically sorted by event_seq
    expect(bundle.aggregates[0].outbox.event_seq).toBe(1);
    expect(bundle.aggregates[1].outbox.event_seq).toBe(2);

    const verification = verifyMigrationBundle(bundle);
    expect(verification.isValid).toBe(true);
    expect(verification.errors).toHaveLength(0);
  });

  it('2. Rejects corrupted migration bundle with checksum mismatch', () => {
    const agg1 = createTestAggregate('sale_001', 'IB1/2627/000101', 1);
    const bundle = createMigrationBundle('T1', 'IB', 1, [agg1]);

    // Tamper with payload
    bundle.aggregates[0].sale.net_payable_paise = 99999;

    const verification = verifyMigrationBundle(bundle);
    expect(verification.isValid).toBe(false);
    expect(verification.errors.some(e => e.includes('Checksum mismatch'))).toBe(true);
  });

  it('3. Rejects migration bundle containing duplicate invoices or conflicting sale IDs', () => {
    const agg1 = createTestAggregate('sale_001', 'IB1/2627/000101', 1);
    const agg2 = createTestAggregate('sale_002', 'IB1/2627/000101', 2); // Duplicate invoice!

    const bundle = createMigrationBundle('T1', 'IB', 1, [agg1, agg2]);
    const verification = verifyMigrationBundle(bundle);

    expect(verification.isValid).toBe(false);
    expect(verification.errors.some(e => e.includes('Duplicate invoice number in bundle'))).toBe(true);
  });

  it('4. Monotonic checkpoint advancement prevents backward progression', () => {
    let cp: MigrationCheckpoint | null = null;
    cp = advanceMigrationCheckpoint(cp, 10, 'sale_010', 'T1', '2026-10-10T10:00:00Z');
    expect(cp.last_migrated_event_seq).toBe(10);

    cp = advanceMigrationCheckpoint(cp, 15, 'sale_015', 'T1', '2026-10-10T10:05:00Z');
    expect(cp.last_migrated_event_seq).toBe(15);

    // Attempting to advance backward or equal must throw
    expect(() => advanceMigrationCheckpoint(cp, 15, 'sale_015', 'T1')).toThrow(/NON_MONOTONIC_CHECKPOINT/);
    expect(() => advanceMigrationCheckpoint(cp, 12, 'sale_012', 'T1')).toThrow(/NON_MONOTONIC_CHECKPOINT/);
  });

  it('5. Executes migration ingestion and verifies financial reconciliation arithmetic', () => {
    const serverState: ServerDatabaseState = {
      committedEvents: new Map(),
      committedAggregates: new Map(),
      outOfOrderBuffer: new Map(),
    };

    const agg1 = createTestAggregate('sale_001', 'IB1/2627/000101', 1, 25500, 15500);
    const agg2 = createTestAggregate('sale_002', 'IB1/2627/000102', 2, 50000, 30000);

    const bundle = createMigrationBundle('T1', 'IB', 1, [agg1, agg2]);
    const report = executeMigrationIngestion(bundle, serverState);

    expect(report.total_attempted).toBe(2);
    expect(report.successful_ingestions).toBe(2);
    expect(report.already_committed_idempotent).toBe(0);
    expect(report.total_net_payable_paise).toBe(75500); // 255 + 500 = 755
    expect(report.total_cash_retained_paise).toBe(45500); // 155 + 300 = 455
    expect(report.is_fully_reconciled).toBe(true);
  });

  it('6. Re-migrating an already-migrated bundle is idempotent and never duplicates balances', () => {
    const serverState: ServerDatabaseState = {
      committedEvents: new Map(),
      committedAggregates: new Map(),
      outOfOrderBuffer: new Map(),
    };

    const agg1 = createTestAggregate('sale_001', 'IB1/2627/000101', 1, 25500, 15500);
    const bundle = createMigrationBundle('T1', 'IB', 1, [agg1]);

    // First ingestion
    const report1 = executeMigrationIngestion(bundle, serverState);
    expect(report1.successful_ingestions).toBe(1);

    // Replay/re-migration of exact same bundle
    const report2 = executeMigrationIngestion(bundle, serverState);
    expect(report2.total_attempted).toBe(1);
    expect(report2.successful_ingestions).toBe(0);
    expect(report2.already_committed_idempotent).toBe(1);
    expect(report2.is_fully_reconciled).toBe(true);
    expect(serverState.committedEvents.size).toBe(1); // Still exactly 1 event on server
  });

  it('7. Rejects payload mutation during migration and reports collision', () => {
    const serverState: ServerDatabaseState = {
      committedEvents: new Map(),
      committedAggregates: new Map(),
      outOfOrderBuffer: new Map(),
    };

    const agg1 = createTestAggregate('sale_001', 'IB1/2627/000101', 1, 25500, 15500);
    const bundle1 = createMigrationBundle('T1', 'IB', 1, [agg1]);
    executeMigrationIngestion(bundle1, serverState);

    // Now create a mutated aggregate with SAME sale ID but changed net payable and hash
    const mutatedAgg = createTestAggregate('sale_001', 'IB1/2627/000101', 1, 99900, 15500);
    const bundle2 = createMigrationBundle('T1', 'IB', 1, [mutatedAgg]);

    const report = executeMigrationIngestion(bundle2, serverState);
    expect(report.rejected_conflicts).toHaveLength(1);
    expect(report.rejected_conflicts[0].aggregate_id).toBe('sale_001');
    expect(report.is_fully_reconciled).toBe(false);
  });

  it('8. Sync status transition never marks SERVER_ACKNOWLEDGED without explicit server ACK', () => {
    // Normal initial offline state
    expect(transitionLocalSyncStatus('LOCAL_DURABLE', false, '')).toBe('LOCAL_DURABLE');
    expect(transitionLocalSyncStatus('SYNC_PENDING', false, 'COMMITTED_ACK')).toBe('SYNC_PENDING'); // dropped ACK

    // Conflict state
    expect(transitionLocalSyncStatus('SYNC_PENDING', false, 'REJECTED_PAYLOAD_MUTATION')).toBe('SYNC_CONFLICT');

    // Valid server ACK received
    expect(transitionLocalSyncStatus('SYNC_PENDING', true, 'COMMITTED_ACK')).toBe('SERVER_ACKNOWLEDGED');
    expect(transitionLocalSyncStatus('SYNC_PENDING', true, 'ALREADY_COMMITTED_IDEMPOTENT_ACK')).toBe('SERVER_ACKNOWLEDGED');
  });
});
