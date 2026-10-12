import crypto from 'node:crypto';
import { CanonicalSaleAggregate } from '@malgudi/contracts';

/**
 * Produces a stable, versioned deterministic JSON string of a CanonicalSaleAggregate
 * by sorting keys and child arrays by their unique IDs.
 */
export function canonicalSerializeAggregate(aggregate: CanonicalSaleAggregate): string {
  const normalized = {
    version: aggregate.version,
    sale: {
      id: aggregate.sale.id,
      invoice_number: aggregate.sale.invoice_number,
      branch_id: aggregate.sale.branch_id,
      counter_id: aggregate.sale.counter_id,
      terminal_id: aggregate.sale.terminal_id,
      session_id: aggregate.sale.session_id,
      business_date: aggregate.sale.business_date,
      tax_policy_version: aggregate.sale.tax_policy_version,
      subtotal_taxable_paise: aggregate.sale.subtotal_taxable_paise,
      total_cgst_paise: aggregate.sale.total_cgst_paise,
      total_sgst_paise: aggregate.sale.total_sgst_paise,
      total_igst_paise: aggregate.sale.total_igst_paise,
      round_off_paise: aggregate.sale.round_off_paise,
      net_payable_paise: aggregate.sale.net_payable_paise,
      sale_status: aggregate.sale.sale_status,
      payment_status: aggregate.sale.payment_status,
      sync_status: aggregate.sale.sync_status,
      created_at: aggregate.sale.created_at,
    },
    items: [...aggregate.items].sort((a, b) => a.id.localeCompare(b.id)),
    payments: [...aggregate.payments].sort((a, b) => a.id.localeCompare(b.id)),
    cash_movements: [...aggregate.cash_movements].sort((a, b) => a.id.localeCompare(b.id)),
    stock_movements: [...aggregate.stock_movements].sort((a, b) => a.id.localeCompare(b.id)),
    outbox: {
      event_id: aggregate.outbox.event_id,
      aggregate_type: aggregate.outbox.aggregate_type,
      aggregate_id: aggregate.outbox.aggregate_id,
      event_seq: aggregate.outbox.event_seq,
      created_at: aggregate.outbox.created_at,
    },
    audit: {
      id: aggregate.audit.id,
      action: aggregate.audit.action,
      entity_type: aggregate.audit.entity_type,
      entity_id: aggregate.audit.entity_id,
      actor_id: aggregate.audit.actor_id,
      created_at: aggregate.audit.created_at,
    },
  };

  return JSON.stringify(normalized);
}

export function computeAggregateSha256(aggregate: CanonicalSaleAggregate): string {
  const json = canonicalSerializeAggregate(aggregate);
  return `v2.9:sha256:${crypto.createHash('sha256').update(json).digest('hex')}`;
}

export interface AggregateVerificationResult {
  isCompleteAndValid: boolean;
  errors: string[];
  calculatedHash: string;
}

export function verifyAggregateInvariants(aggregate: CanonicalSaleAggregate): AggregateVerificationResult {
  const errors: string[] = [];
  const saleId = aggregate.sale.id;

  // 1. Mandatory Root Fields
  if (!saleId) errors.push('Missing sale.id');
  if (!aggregate.sale.invoice_number) errors.push('Missing sale.invoice_number');

  // 2. Aggregate Link Integrity
  if (aggregate.outbox.aggregate_id !== saleId) {
    errors.push(`Outbox aggregate_id (${aggregate.outbox.aggregate_id}) does not match sale.id (${saleId})`);
  }
  if (aggregate.audit.entity_id !== saleId) {
    errors.push(`Audit entity_id (${aggregate.audit.entity_id}) does not match sale.id (${saleId})`);
  }

  // 3. Child Record Links
  for (const item of aggregate.items) {
    if (!item.product_id) errors.push(`Item ${item.id} missing product_id`);
  }
  for (const p of aggregate.payments) {
    if (p.allocated_amount_paise <= 0) errors.push(`Payment ${p.id} has non-positive allocation`);
  }
  for (const cm of aggregate.cash_movements) {
    if (cm.reference_id !== saleId) {
      errors.push(`Cash movement ${cm.id} reference_id does not match sale.id`);
    }
  }
  for (const sm of aggregate.stock_movements) {
    if (sm.reference_id !== saleId) {
      errors.push(`Stock movement ${sm.id} reference_id does not match sale.id`);
    }
  }

  // 4. Items & Stock Movements Business Rules
  if (aggregate.items.length === 0) {
    errors.push('Sale aggregate must have at least one sale item');
  }
  // Stock movements are mandatory ONLY for items with stock_deduction_delta != 0 (tangible stock)
  const expectedStockMovementsCount = aggregate.items.filter(item => item.stock_deduction_delta !== 0).length;
  if (aggregate.stock_movements.length !== expectedStockMovementsCount) {
    errors.push(`Stock movements count (${aggregate.stock_movements.length}) does not match stock-tracked items count (${expectedStockMovementsCount})`);
  }

  // 5. Payment Tender vs Cash Movements Business Rules
  const cashPayments = aggregate.payments.filter(p => p.payment_method === 'CASH');
  if (cashPayments.length > 0) {
    if (aggregate.cash_movements.length === 0) {
      errors.push('Cash payment is present but cash drawer movement is missing');
    }
    const totalNetCashAllocated = cashPayments.reduce((s, p) => s + p.net_amount_paise, 0);
    const totalCashDrawerInflow = aggregate.cash_movements
      .filter(cm => cm.movement_type === 'CASH_SALE')
      .reduce((s, cm) => s + cm.amount_paise, 0);

    if (totalNetCashAllocated !== totalCashDrawerInflow) {
      errors.push(`Net cash allocated (${totalNetCashAllocated}) does not match drawer inflow (${totalCashDrawerInflow})`);
    }
  } else {
    // Pure non-cash bill: MUST NOT have a cash drawer movement!
    if (aggregate.cash_movements.length > 0) {
      errors.push('Non-cash sale must not generate physical cash drawer movements');
    }
  }

  const calculatedHash = computeAggregateSha256(aggregate);

  return {
    isCompleteAndValid: errors.length === 0,
    errors,
    calculatedHash,
  };
}

export interface MockDatabaseState {
  sales: Map<string, { id: string; invoice_number: string; payload_hash: string }>;
  invoices: Set<string>;
}

export type RecoveryOutcome = 
  | { status: 'CLEAN_RECOVERED'; aggregateId: string; invoiceNumber: string; hash: string }
  | { status: 'ALREADY_RECOVERED'; aggregateId: string; invoiceNumber: string; message: string }
  | { status: 'QUARANTINE_MUTATION'; aggregateId: string; expectedHash: string; existingHash: string; reason: string }
  | { status: 'QUARANTINE_INVOICE_COLLISION'; invoiceNumber: string; conflictingSaleId: string; reason: string }
  | { status: 'QUARANTINE_INCOMPLETE'; aggregateId: string; missingRules: string[] };

/**
 * Reconciles and recovers a candidate aggregate into the database.
 * Reconciles child records, detects collisions, mutations, incomplete trees, and ensures idempotency.
 */
export function recoverAggregate(
  db: MockDatabaseState,
  candidate: CanonicalSaleAggregate
): RecoveryOutcome {
  // Step 1: Verify internal invariant completeness according to business rules
  const verification = verifyAggregateInvariants(candidate);
  if (!verification.isCompleteAndValid) {
    return {
      status: 'QUARANTINE_INCOMPLETE',
      aggregateId: candidate.sale.id,
      missingRules: verification.errors,
    };
  }

  const saleId = candidate.sale.id;
  const invoiceNumber = candidate.sale.invoice_number;
  const currentHash = verification.calculatedHash;

  // Step 2: Check for existing aggregate by sale ID
  if (db.sales.has(saleId)) {
    const existing = db.sales.get(saleId)!;
    if (existing.payload_hash === currentHash) {
      // Clean, idempotent recovery of already-imported aggregate
      return {
        status: 'ALREADY_RECOVERED',
        aggregateId: saleId,
        invoiceNumber,
        message: 'Aggregate already recovered with matching canonical hash; no duplicate records inserted.',
      };
    } else {
      // Divergence detected!
      return {
        status: 'QUARANTINE_MUTATION',
        aggregateId: saleId,
        expectedHash: currentHash,
        existingHash: existing.payload_hash,
        reason: 'Payload mutation detected: Existing database record has different payload hash for same sale ID',
      };
    }
  }

  // Step 3: Check for invoice number collision (different sale ID attempting to reuse existing invoice number)
  if (db.invoices.has(invoiceNumber)) {
    return {
      status: 'QUARANTINE_INVOICE_COLLISION',
      invoiceNumber,
      conflictingSaleId: saleId,
      reason: `Invoice number ${invoiceNumber} already allocated to a different transaction; quarantined to preserve Rule 46(b) serial integrity`,
    };
  }

  // Step 4: Clean recovery
  db.sales.set(saleId, {
    id: saleId,
    invoice_number: invoiceNumber,
    payload_hash: currentHash,
  });
  db.invoices.add(invoiceNumber);

  return {
    status: 'CLEAN_RECOVERED',
    aggregateId: saleId,
    invoiceNumber,
    hash: currentHash,
  };
}
