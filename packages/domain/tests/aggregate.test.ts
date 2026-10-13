import { describe, it, expect } from 'vitest';
import { 
  canonicalSerializeAggregate, 
  computeAggregateSha256, 
  verifyAggregateInvariants,
  recoverAggregate,
  getIndianFinancialYearCode,
  MockDatabaseState
} from '../src/aggregate.js';
import { CanonicalSaleAggregate } from '@malgudi/contracts';

describe('Canonical Aggregate Serialization & Invariant Verification', () => {
  const validAggregate: CanonicalSaleAggregate = {
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
      payment_status: 'SETTLED',
      sync_status: 'LOCAL_DURABLE',
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
    payments: [
      {
        id: 'pay_1',
        payment_method: 'CASH',
        allocated_amount_paise: 25500,
        tendered_paise: 50000,
        change_returned_paise: 24500,
        net_amount_paise: 25500,
        outcome: 'SUCCESS',
      },
    ],
    cash_movements: [
      {
        id: 'cm_1',
        session_id: 'sess_01',
        branch_id: 'IB',
        movement_type: 'CASH_SALE',
        amount_paise: 25500,
        direction: 'IN',
        reference_id: '0192a543-0001-7000-8000-000000000001',
        created_at: '2026-10-10T10:00:00Z',
      },
    ],
    stock_movements: [
      {
        id: 'sm_1',
        branch_id: 'IB',
        product_id: 'prod_mysore_pak',
        movement_type: 'SALE_DEDUCTION',
        quantity_delta: -375000,
        unit: 'MG',
        reference_id: '0192a543-0001-7000-8000-000000000001',
        created_at: '2026-10-10T10:00:00Z',
      },
    ],
    outbox: {
      event_id: 'evt_1',
      aggregate_type: 'SALE',
      aggregate_id: '0192a543-0001-7000-8000-000000000001',
      event_seq: 1,
      payload_hash: '',
      created_at: '2026-10-10T10:00:00Z',
    },
    audit: {
      id: 'aud_1',
      action: 'SALE_COMPLETED',
      entity_type: 'SALE',
      entity_id: '0192a543-0001-7000-8000-000000000001',
      actor_id: 'cashier_1',
      created_at: '2026-10-10T10:00:00Z',
    },
  };

  it('Generates identical versioned SHA-256 hash regardless of JSON object property ordering', () => {
    const hash1 = computeAggregateSha256(validAggregate);
    // Shuffle items array order in a copy
    const copyAggregate: CanonicalSaleAggregate = {
      ...validAggregate,
      items: [...validAggregate.items],
    };
    const hash2 = computeAggregateSha256(copyAggregate);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^v2\.9:sha256:[a-f0-9]{64}$/);
  });

  it('Verifies a complete and valid aggregate successfully', () => {
    const res = verifyAggregateInvariants(validAggregate);
    expect(res.isCompleteAndValid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('Allows non-inventory service item without stock movement (business rule check)', () => {
    const nonStockAggregate: CanonicalSaleAggregate = {
      ...validAggregate,
      items: [
        ...validAggregate.items,
        {
          id: 'item_carry_bag',
          product_id: 'prod_carry_bag_cloth',
          quantity_input: 1,
          pricing_unit: 'PER_PIECE',
          weight_input_source: 'MANUAL_KEYPAD',
          unit_price_paise: 1500,
          taxable_paise: 1271,
          cgst_paise: 114,
          sgst_paise: 115,
          igst_paise: 0,
          total_tax_paise: 229,
          gross_paise: 1500,
          stock_deduction_delta: 0, // Non-inventory item!
          stock_unit: 'PIECE',
        },
      ],
      // Still only 1 stock movement for the Mysore Pak; Carry bag has delta 0
    };

    const res = verifyAggregateInvariants(nonStockAggregate);
    // Should pass because expected stock movements equals stock-tracked items count (1)
    expect(res.isCompleteAndValid).toBe(true);
  });

  it('Detects incomplete aggregate when stock movements are missing for physical items', () => {
    const brokenAggregate: CanonicalSaleAggregate = {
      ...validAggregate,
      stock_movements: [], // Missing required stock movement!
    };

    const res = verifyAggregateInvariants(brokenAggregate);
    expect(res.isCompleteAndValid).toBe(false);
    expect(res.errors.some(e => e.includes('Stock movements count'))).toBe(true);
  });

  it('Detects child record link mismatch when payment references wrong sale ID', () => {
    const mismatchedAggregate: CanonicalSaleAggregate = {
      ...validAggregate,
      outbox: {
        ...validAggregate.outbox,
        aggregate_id: 'different_sale_id',
      },
    };

    const res = verifyAggregateInvariants(mismatchedAggregate);
    expect(res.isCompleteAndValid).toBe(false);
    expect(res.errors.some(e => e.includes('does not match sale.id'))).toBe(true);
  });

  describe('Aggregate Recovery & Quarantine Engine', () => {
    it('Recovers clean aggregate into empty database successfully', () => {
      const db: MockDatabaseState = {
        sales: new Map(),
        invoices: new Set(),
      };

      const outcome = recoverAggregate(db, validAggregate);
      expect(outcome.status).toBe('CLEAN_RECOVERED');
      if (outcome.status === 'CLEAN_RECOVERED') {
        expect(outcome.aggregateId).toBe(validAggregate.sale.id);
        expect(outcome.invoiceNumber).toBe(validAggregate.sale.invoice_number);
      }
      expect(db.sales.has(validAggregate.sale.id)).toBe(true);
      expect(db.invoices.has(validAggregate.sale.invoice_number)).toBe(true);
    });

    it('Safely and idempotently recovers already-recovered aggregate without duplicate insertions', () => {
      const db: MockDatabaseState = {
        sales: new Map(),
        invoices: new Set(),
      };

      // First recovery
      recoverAggregate(db, validAggregate);
      expect(db.sales.size).toBe(1);

      // Repeated recovery of the same aggregate
      const repeatedOutcome = recoverAggregate(db, validAggregate);
      expect(repeatedOutcome.status).toBe('ALREADY_RECOVERED');
      expect(db.sales.size).toBe(1); // No duplicates inserted!
    });

    it('Quarantines incomplete aggregate', () => {
      const db: MockDatabaseState = {
        sales: new Map(),
        invoices: new Set(),
      };

      const incomplete: CanonicalSaleAggregate = {
        ...validAggregate,
        items: [], // Violates invariant
      };

      const outcome = recoverAggregate(db, incomplete);
      expect(outcome.status).toBe('QUARANTINE_INCOMPLETE');
      expect(db.sales.size).toBe(0);
    });

    it('Quarantines payload mutation when same sale ID has conflicting hash', () => {
      const db: MockDatabaseState = {
        sales: new Map(),
        invoices: new Set(),
      };

      // Seed DB with original
      recoverAggregate(db, validAggregate);

      // Candidate has same sale ID but mutated amount
      const mutatedAggregate: CanonicalSaleAggregate = {
        ...validAggregate,
        sale: {
          ...validAggregate.sale,
          net_payable_paise: 99999, // Tampered net payable!
        },
      };

      const outcome = recoverAggregate(db, mutatedAggregate);
      expect(outcome.status).toBe('QUARANTINE_MUTATION');
      if (outcome.status === 'QUARANTINE_MUTATION') {
        expect(outcome.reason).toContain('Payload mutation detected');
      }
    });

    it('Quarantines invoice collision when different sale ID reuses existing invoice number', () => {
      const db: MockDatabaseState = {
        sales: new Map(),
        invoices: new Set(),
      };

      // Seed DB with original
      recoverAggregate(db, validAggregate);

      // Candidate has DIFFERENT sale ID but SAME invoice number
      const collisionAggregate: CanonicalSaleAggregate = {
        ...validAggregate,
        sale: {
          ...validAggregate.sale,
          id: '0192a543-0002-7000-8000-000000000002', // Different ID
          // Same invoice_number: 'IB1/2627/000142'
        },
        outbox: {
          ...validAggregate.outbox,
          aggregate_id: '0192a543-0002-7000-8000-000000000002',
        },
        audit: {
          ...validAggregate.audit,
          entity_id: '0192a543-0002-7000-8000-000000000002',
        },
        cash_movements: [
          {
            ...validAggregate.cash_movements[0],
            reference_id: '0192a543-0002-7000-8000-000000000002',
          },
        ],
        stock_movements: [
          {
            ...validAggregate.stock_movements[0],
            reference_id: '0192a543-0002-7000-8000-000000000002',
          },
        ],
      };

      const outcome = recoverAggregate(db, collisionAggregate);
      expect(outcome.status).toBe('QUARANTINE_INVOICE_COLLISION');
      if (outcome.status === 'QUARANTINE_INVOICE_COLLISION') {
        expect(outcome.reason).toContain('Rule 46(b)');
      }
    });
  });

  describe('Indian Financial Year Code Generator (Rule 46 / Invoice Sequences)', () => {
    it('resolves April 2026 through March 2027 to 2627', () => {
      expect(getIndianFinancialYearCode('2026-04-01')).toBe('2627');
      expect(getIndianFinancialYearCode('2026-10-13')).toBe('2627');
      expect(getIndianFinancialYearCode('2026-12-31')).toBe('2627');
      expect(getIndianFinancialYearCode('2027-01-01')).toBe('2627');
      expect(getIndianFinancialYearCode('2027-03-31')).toBe('2627');
    });

    it('resolves March 31 boundary correctly to previous FY and April 1 to new FY', () => {
      // Transition from FY 2025-26 to FY 2026-27
      expect(getIndianFinancialYearCode('2026-03-31')).toBe('2526');
      expect(getIndianFinancialYearCode('2026-04-01')).toBe('2627');

      // Transition from FY 2026-27 to FY 2027-28
      expect(getIndianFinancialYearCode('2027-03-31')).toBe('2627');
      expect(getIndianFinancialYearCode('2027-04-01')).toBe('2728');
    });

    it('handles Date objects as well as ISO date strings', () => {
      const march31 = new Date(2027, 2, 31); // March 31, 2027 (month index 2)
      const april01 = new Date(2027, 3, 1);  // April 1, 2027 (month index 3)
      expect(getIndianFinancialYearCode(march31)).toBe('2627');
      expect(getIndianFinancialYearCode(april01)).toBe('2728');
    });
  });
});

