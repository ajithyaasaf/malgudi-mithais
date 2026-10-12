import { describe, it, expect } from 'vitest';
import { CanonicalSaleAggregate } from '@malgudi/contracts';
import { verifyAggregateInvariants, computeAggregateSha256 } from '../src/aggregate.js';

describe('Local Data Ownership & Offline Persistence Invariants', () => {
  const createValidCanonicalSale = (
    id: string = 'sale_local_001',
    netPayablePaise: number = 25500,
    cashAmountPaise: number = 15500
  ): CanonicalSaleAggregate => {
    const agg: CanonicalSaleAggregate = {
      version: '2.9',
      sale: {
        id,
        invoice_number: 'IB1/2627/000888',
        branch_id: 'IB',
        counter_id: 'C1',
        terminal_id: 'T1',
        session_id: 'sess_madurai_01',
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
          session_id: 'sess_madurai_01',
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
        event_seq: 1,
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
    agg.outbox.payload_hash = computeAggregateSha256(agg);
    return agg;
  };

  it('1. Authoritative local aggregate passes all multi-table completeness checks', () => {
    const sale = createValidCanonicalSale();
    const result = verifyAggregateInvariants(sale);

    expect(result.isCompleteAndValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.calculatedHash).toMatch(/^v2\.9:sha256:[a-f0-9]{64}$/);
  });

  it('2. Local billing invariant: Cash payments must strictly equal physical drawer movements', () => {
    const sale = createValidCanonicalSale('sale_bad_cash', 25500, 15500);
    // Tamper with cash movement to simulate cash drawer leakage
    sale.cash_movements[0].amount_paise = 10000; // ₹100 instead of ₹155

    const result = verifyAggregateInvariants(sale);
    expect(result.isCompleteAndValid).toBe(false);
    expect(result.errors.some(e => e.includes('Net cash allocated (15500) does not match drawer inflow (10000)'))).toBe(true);
  });

  it('3. Local billing invariant: Pure digital payments must not create cash drawer movements', () => {
    const sale = createValidCanonicalSale('sale_digital', 25500, 0);
    // Pure digital sale
    sale.payments = [
      {
        id: 'pay_upi_full',
        payment_method: 'UPI_GATEWAY_DYNAMIC',
        allocated_amount_paise: 25500,
        tendered_paise: 25500,
        change_returned_paise: 0,
        net_amount_paise: 25500,
        outcome: 'SUCCESS',
      },
    ];
    // Erroneously added cash movement
    sale.cash_movements = [
      {
        id: 'cm_erroneous',
        session_id: 'sess_01',
        branch_id: 'IB',
        movement_type: 'CASH_SALE',
        amount_paise: 5000,
        direction: 'IN',
        reference_id: 'sale_digital',
        created_at: '2026-10-10T10:00:00.000Z',
      },
    ];

    const result = verifyAggregateInvariants(sale);
    expect(result.isCompleteAndValid).toBe(false);
    expect(result.errors.some(e => e.includes('Non-cash sale must not generate physical cash drawer movements'))).toBe(true);
  });

  it('4. Inventory invariant: Tangible sold items must strictly match stock deductions', () => {
    const sale = createValidCanonicalSale('sale_no_sm', 25500, 15500);
    sale.stock_movements = []; // Missing stock movement for Mysore Pak

    const result = verifyAggregateInvariants(sale);
    expect(result.isCompleteAndValid).toBe(false);
    expect(result.errors.some(e => e.includes('Stock movements count (0) does not match stock-tracked items count (1)'))).toBe(true);
  });

  it('5. Durable Outbox invariant: Every sale must possess an outbox event linked to the sale ID', () => {
    const sale = createValidCanonicalSale('sale_unlinked_outbox', 25500, 15500);
    sale.outbox.aggregate_id = 'different_sale_id';

    const result = verifyAggregateInvariants(sale);
    expect(result.isCompleteAndValid).toBe(false);
    expect(result.errors.some(e => e.includes('Outbox aggregate_id (different_sale_id) does not match sale.id'))).toBe(true);
  });
});
