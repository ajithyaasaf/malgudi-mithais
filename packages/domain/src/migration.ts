import crypto from 'node:crypto';
import { CanonicalSaleAggregate, SyncStatus } from '@malgudi/contracts';
import { verifyAggregateInvariants, canonicalSerializeAggregate } from './aggregate.js';
import { ServerDatabaseState, ingestSyncEvent, ServerSyncEvent } from './sync.js';

export interface MigrationBundleMetadata {
  export_version: '2.9';
  source_terminal_id: string;
  source_branch_id: string;
  schema_version: number;
  exported_at: string;
  total_records: number;
  sha256_checksum: string;
}

export interface MigrationBundle {
  metadata: MigrationBundleMetadata;
  aggregates: CanonicalSaleAggregate[];
}

export interface MigrationCheckpoint {
  terminal_id: string;
  last_migrated_event_seq: number;
  last_migrated_aggregate_id: string;
  updated_at: string;
}

export interface MigrationReconciliationReport {
  total_attempted: number;
  successful_ingestions: number;
  already_committed_idempotent: number;
  rejected_conflicts: Array<{ aggregate_id: string; reason: string }>;
  buffered_waiting_parent: number;
  total_net_payable_paise: number;
  total_cash_retained_paise: number;
  is_fully_reconciled: boolean;
}

/**
 * Creates a verifiable, portable Migration Bundle for exporting local SQLite records
 * for future central cloud database migration.
 */
export function createMigrationBundle(
  terminalId: string,
  branchId: string,
  schemaVersion: number,
  aggregates: CanonicalSaleAggregate[],
  exportedAt: string = new Date().toISOString()
): MigrationBundle {
  // Sort aggregates deterministically by outbox event_seq then creation timestamp
  const sortedAggregates = [...aggregates].sort((a, b) => {
    if (a.outbox.event_seq !== b.outbox.event_seq) {
      return a.outbox.event_seq - b.outbox.event_seq;
    }
    return a.sale.created_at.localeCompare(b.sale.created_at);
  });

  // Calculate cryptographic checksum over the serialized aggregates
  const payloadToHash = sortedAggregates.map(agg => canonicalSerializeAggregate(agg)).join('\n');
  const checksum = crypto.createHash('sha256').update(payloadToHash).digest('hex');

  const metadata: MigrationBundleMetadata = {
    export_version: '2.9',
    source_terminal_id: terminalId,
    source_branch_id: branchId,
    schema_version: schemaVersion,
    exported_at: exportedAt,
    total_records: sortedAggregates.length,
    sha256_checksum: checksum,
  };

  return {
    metadata,
    aggregates: sortedAggregates,
  };
}

/**
 * Validates a Migration Bundle before ingesting it into cloud storage.
 * Verifies schema version, cryptographic checksum, and multi-aggregate business invariants.
 */
export function verifyMigrationBundle(bundle: MigrationBundle): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (bundle.metadata.export_version !== '2.9') {
    errors.push(`Unsupported export version: ${bundle.metadata.export_version}`);
  }

  if (bundle.metadata.schema_version < 1) {
    errors.push(`Invalid schema version: ${bundle.metadata.schema_version}`);
  }

  if (bundle.aggregates.length !== bundle.metadata.total_records) {
    errors.push(
      `Record count mismatch: metadata specifies ${bundle.metadata.total_records}, but bundle contains ${bundle.aggregates.length}`
    );
  }

  // Recalculate and verify checksum
  const payloadToHash = bundle.aggregates.map(agg => canonicalSerializeAggregate(agg)).join('\n');
  const actualChecksum = crypto.createHash('sha256').update(payloadToHash).digest('hex');
  if (actualChecksum !== bundle.metadata.sha256_checksum) {
    errors.push(`Checksum mismatch: expected ${bundle.metadata.sha256_checksum}, calculated ${actualChecksum}`);
  }

  // Validate internal invariants for each individual record
  const seenInvoices = new Set<string>();
  const seenSaleIds = new Set<string>();

  for (const agg of bundle.aggregates) {
    const invResult = verifyAggregateInvariants(agg);
    if (!invResult.isCompleteAndValid) {
      errors.push(`Aggregate ${agg.sale.id} invariant failure: ${invResult.errors.join('; ')}`);
    }

    if (seenSaleIds.has(agg.sale.id)) {
      errors.push(`Duplicate sale ID in bundle: ${agg.sale.id}`);
    }
    seenSaleIds.add(agg.sale.id);

    if (seenInvoices.has(agg.sale.invoice_number)) {
      errors.push(`Duplicate invoice number in bundle: ${agg.sale.invoice_number}`);
    }
    seenInvoices.add(agg.sale.invoice_number);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Updates a migration checkpoint ensuring strict monotonic progress.
 */
export function advanceMigrationCheckpoint(
  current: MigrationCheckpoint | null,
  newSeq: number,
  aggregateId: string,
  terminalId: string,
  updatedAt: string = new Date().toISOString()
): MigrationCheckpoint {
  if (current && newSeq <= current.last_migrated_event_seq) {
    throw new Error(
      `NON_MONOTONIC_CHECKPOINT: Proposed seq ${newSeq} is not strictly greater than current checkpoint ${current.last_migrated_event_seq}`
    );
  }

  return {
    terminal_id: terminalId,
    last_migrated_event_seq: newSeq,
    last_migrated_aggregate_id: aggregateId,
    updated_at: updatedAt,
  };
}

/**
 * Simulates or performs migration ingestion of a Migration Bundle into a central server.
 * Returns a comprehensive reconciliation report.
 */
export function executeMigrationIngestion(
  bundle: MigrationBundle,
  serverState: ServerDatabaseState
): MigrationReconciliationReport {
  let successfulIngestions = 0;
  let alreadyCommittedIdempotent = 0;
  let bufferedWaitingParent = 0;
  const rejectedConflicts: Array<{ aggregate_id: string; reason: string }> = [];

  let totalNetPayablePaise = 0;
  let totalCashRetainedPaise = 0;

  for (const agg of bundle.aggregates) {
    const event: ServerSyncEvent = {
      event_id: agg.outbox.event_id,
      aggregate_type: agg.outbox.aggregate_type,
      aggregate_id: agg.outbox.aggregate_id,
      payload_json: canonicalSerializeAggregate(agg),
      payload_hash: agg.outbox.payload_hash,
      created_at: agg.outbox.created_at,
    };

    const res = ingestSyncEvent(serverState, event, agg, false);

    if (res.status === 'COMMITTED_ACK') {
      successfulIngestions++;
      totalNetPayablePaise += agg.sale.net_payable_paise;
      const cashPayments = agg.payments.filter(p => p.payment_method === 'CASH');
      totalCashRetainedPaise += cashPayments.reduce((s, p) => s + p.net_amount_paise, 0);
    } else if (res.status === 'ALREADY_COMMITTED_IDEMPOTENT_ACK') {
      alreadyCommittedIdempotent++;
      totalNetPayablePaise += agg.sale.net_payable_paise;
      const cashPayments = agg.payments.filter(p => p.payment_method === 'CASH');
      totalCashRetainedPaise += cashPayments.reduce((s, p) => s + p.net_amount_paise, 0);
    } else if (res.status === 'BUFFERED_WAITING_PARENT') {
      bufferedWaitingParent++;
    } else if (res.status === 'REJECTED_PAYLOAD_MUTATION') {
      rejectedConflicts.push({
        aggregate_id: agg.sale.id,
        reason: res.message,
      });
    }
  }

  return {
    total_attempted: bundle.aggregates.length,
    successful_ingestions: successfulIngestions,
    already_committed_idempotent: alreadyCommittedIdempotent,
    rejected_conflicts: rejectedConflicts,
    buffered_waiting_parent: bufferedWaitingParent,
    total_net_payable_paise: totalNetPayablePaise,
    total_cash_retained_paise: totalCashRetainedPaise,
    is_fully_reconciled: rejectedConflicts.length === 0 && bufferedWaitingParent === 0,
  };
}

/**
 * Updates a local record's synchronization state.
 * Invariant: Never transitions to SERVER_ACKNOWLEDGED unless server explicitly returns valid ACK.
 */
export function transitionLocalSyncStatus(
  currentStatus: SyncStatus,
  serverAcknowledged: boolean,
  serverStatus: string
): SyncStatus {
  if (serverAcknowledged && (serverStatus === 'COMMITTED_ACK' || serverStatus === 'ALREADY_COMMITTED_IDEMPOTENT_ACK')) {
    return 'SERVER_ACKNOWLEDGED';
  }

  if (serverStatus === 'REJECTED_PAYLOAD_MUTATION') {
    return 'SYNC_CONFLICT';
  }

  // Network failure, dropped ACK, or buffered child: remains SYNC_PENDING (or LOCAL_DURABLE)
  return currentStatus === 'LOCAL_DURABLE' ? 'LOCAL_DURABLE' : 'SYNC_PENDING';
}
