import { describe, it, expect } from 'vitest';
import { planReversal } from '../src/reversals.js';
import { CanonicalSaleAggregate } from '@malgudi/contracts';

describe('Reversals & Voids Engine', () => {
  const sampleCompletedAggregate: CanonicalSaleAggregate = {
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
      payload_hash: 'hash_1',
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

  it('Refunds completed cash bill with sellable restock disposition', () => {
    const plan = planReversal({
      originalAggregate: sampleCompletedAggregate,
      reversalReason: 'Customer changed mind before leaving counter',
      supervisorId: 'sup_01',
      itemReturns: [
        {
          item_id: 'item_1',
          quantity_to_return: 375000,
          disposition: 'RESTOCK_SELLABLE',
        },
      ],
    });

    expect(plan.reversalType).toBe('REFUND_COMPLETED');
    expect(plan.isFullVoid).toBe(true);

    // Cash refund movement
    expect(plan.cashMovementsToExecute).toHaveLength(1);
    expect(plan.cashMovementsToExecute[0]).toMatchObject({
      movement_type: 'CASH_REFUND',
      amount_paise: 25500,
      direction: 'OUT',
    });

    // Stock returned as sellable (positive delta)
    expect(plan.stockMovementsToExecute).toHaveLength(1);
    expect(plan.stockMovementsToExecute[0]).toMatchObject({
      product_id: 'prod_mysore_pak',
      movement_type: 'CUSTOMER_RETURN_RESTOCK',
      quantity_delta: 375000, // +375,000 mg
      unit: 'MG',
    });

    expect(plan.updatedSaleStatus).toBe('RETURNED_FULL');
    expect(plan.updatedPaymentStatus).toBe('REFUNDED');
  });

  it('Refunds damaged item with DAMAGED_SCRAP disposition (no sellable restock)', () => {
    const plan = planReversal({
      originalAggregate: sampleCompletedAggregate,
      reversalReason: 'Package dropped and crushed',
      supervisorId: 'sup_01',
      itemReturns: [
        {
          item_id: 'item_1',
          quantity_to_return: 375000,
          disposition: 'DAMAGED_SCRAP',
        },
      ],
    });

    // Stock recorded as damage wastage (does not increase sellable inventory!)
    expect(plan.stockMovementsToExecute[0]).toMatchObject({
      movement_type: 'WASTAGE_DAMAGE',
      quantity_delta: -375000, // Negative damage write-off
    });
  });

  it('Voids an unpaid/aborted sale: restores tentative stock without cash refund', () => {
    const unpaidAggregate: CanonicalSaleAggregate = {
      ...sampleCompletedAggregate,
      sale: {
        ...sampleCompletedAggregate.sale,
        payment_status: 'UNSETTLED_PENDING',
      },
      payments: [], // No payment received
      cash_movements: [],
    };

    const plan = planReversal({
      originalAggregate: unpaidAggregate,
      reversalReason: 'Customer walked away before payment',
      supervisorId: 'sup_01',
    });

    // Zero cash movements!
    expect(plan.cashMovementsToExecute).toHaveLength(0);

    // Stock reversed back to available
    expect(plan.stockMovementsToExecute).toHaveLength(1);
    expect(plan.stockMovementsToExecute[0]).toMatchObject({
      movement_type: 'VOID_STOCK_REVERSAL',
      quantity_delta: 375000,
    });

    expect(plan.updatedSaleStatus).toBe('VOIDED');
  });

  it('Cancels partially paid sale: refunds only actual received cash', () => {
    const partiallyPaidAggregate: CanonicalSaleAggregate = {
      ...sampleCompletedAggregate,
      sale: {
        ...sampleCompletedAggregate.sale,
        payment_status: 'PAYMENT_FAILED',
      },
      payments: [
        {
          id: 'pay_partial_cash',
          payment_method: 'CASH',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        },
      ],
      cash_movements: [
        {
          id: 'cm_partial',
          session_id: 'sess_01',
          branch_id: 'IB',
          movement_type: 'CASH_SALE',
          amount_paise: 10000,
          direction: 'IN',
          reference_id: '0192a543-0001-7000-8000-000000000001',
          created_at: '2026-10-10T10:00:00Z',
        },
      ],
    };

    const plan = planReversal({
      originalAggregate: partiallyPaidAggregate,
      reversalReason: 'UPI gateway timed out after partial cash tender; transaction aborted',
      supervisorId: 'sup_01',
    });

    expect(plan.reversalType).toBe('CANCEL_PARTIAL');
    // Refunds ONLY the ₹100 cash received!
    expect(plan.cashMovementsToExecute).toHaveLength(1);
    expect(plan.cashMovementsToExecute[0].amount_paise).toBe(10000);
    expect(plan.cashMovementsToExecute[0].movement_type).toBe('CASH_REFUND');
    expect(plan.updatedSaleStatus).toBe('VOIDED');
  });

  it('Refunds completed 100% UPI bill without creating cash drawer outflow', () => {
    const upiAggregate: CanonicalSaleAggregate = {
      ...sampleCompletedAggregate,
      payments: [
        {
          id: 'pay_upi',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 25500,
          tendered_paise: 25500,
          change_returned_paise: 0,
          net_amount_paise: 25500,
          outcome: 'SUCCESS',
        },
      ],
      cash_movements: [], // No cash was received
    };

    const plan = planReversal({
      originalAggregate: upiAggregate,
      reversalReason: 'Customer refund via UPI source account',
      supervisorId: 'sup_01',
    });

    // Does not pull physical cash out of drawer!
    expect(plan.refundMethod).toBe('ORIGINAL_PAYMENT_METHOD');
    expect(plan.cashMovementsToExecute).toHaveLength(0);
    expect(plan.updatedSaleStatus).toBe('RETURNED_FULL');
  });

  it('Rejects duplicate reversal on an already-voided sale (Idempotency)', () => {
    const alreadyVoidedAggregate: CanonicalSaleAggregate = {
      ...sampleCompletedAggregate,
      sale: {
        ...sampleCompletedAggregate.sale,
        sale_status: 'VOIDED',
      },
    };

    expect(() => {
      planReversal({
        originalAggregate: alreadyVoidedAggregate,
        reversalReason: 'Accidental duplicate void button click',
        supervisorId: 'sup_01',
      });
    }).toThrow(/already reversed/);
  });

  it('Handles REJECTED_NO_RETURN disposition by generating zero stock movements', () => {
    const plan = planReversal({
      originalAggregate: sampleCompletedAggregate,
      reversalReason: 'Food item consumed; financial courtesy refund only',
      supervisorId: 'sup_01',
      itemReturns: [
        {
          item_id: 'item_1',
          quantity_to_return: 375000,
          disposition: 'REJECTED_NO_RETURN',
        },
      ],
    });

    // Zero stock movements
    expect(plan.stockMovementsToExecute).toHaveLength(0);
  });

  it('Rejects restocking non-inventory items with zero prior stock deduction', () => {
    const aggregateWithNonInventory: CanonicalSaleAggregate = {
      ...sampleCompletedAggregate,
      items: [
        ...sampleCompletedAggregate.items,
        {
          id: 'item_bag',
          product_id: 'prod_carry_bag',
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
          stock_deduction_delta: 0, // Zero prior deduction!
          stock_unit: 'PIECE',
        },
      ],
    };

    expect(() => {
      planReversal({
        originalAggregate: aggregateWithNonInventory,
        reversalReason: 'Customer wants to return paper bag for refund',
        supervisorId: 'sup_01',
        itemReturns: [
          {
            item_id: 'item_bag',
            quantity_to_return: 1,
            disposition: 'RESTOCK_SELLABLE',
          },
        ],
      });
    }).toThrow(/zero prior stock deduction/);
  });

  it('Rejects restocking quantity greater than original purchase', () => {
    expect(() => {
      planReversal({
        originalAggregate: sampleCompletedAggregate,
        reversalReason: 'Attempt to return 1kg on a 375g purchase',
        supervisorId: 'sup_01',
        itemReturns: [
          {
            item_id: 'item_1',
            quantity_to_return: 1000000, // 1kg attempted, sold 375g!
            disposition: 'RESTOCK_SELLABLE',
          },
        ],
      });
    }).toThrow(/exceeds prior deduction/);
  });

  it('Rejects cumulative partial returns when sum exceeds original sale quantity', () => {
    // Original sale was 375,000 mg.
    // First return of 200,000 mg was previously completed.
    const aggregateAfterFirstReturn: CanonicalSaleAggregate = {
      ...sampleCompletedAggregate,
      items: [
        {
          ...sampleCompletedAggregate.items[0],
          cumulative_restocked_quantity: 200000, // 200g already returned
        },
      ],
    };

    // Attempting to return another 200,000 mg (200g + 200g = 400g > 375g) MUST fail!
    expect(() => {
      planReversal({
        originalAggregate: aggregateAfterFirstReturn,
        reversalReason: 'Second partial return of 200g exceeds remaining 175g unreversed',
        supervisorId: 'sup_01',
        itemReturns: [
          {
            item_id: 'item_1',
            quantity_to_return: 200000,
            disposition: 'RESTOCK_SELLABLE',
          },
        ],
      });
    }).toThrow(/Cumulative return quantity/);

    // Returning remaining 175,000 mg MUST succeed
    const validSecondReturn = planReversal({
      originalAggregate: aggregateAfterFirstReturn,
      reversalReason: 'Second partial return of exactly remaining 175g',
      supervisorId: 'sup_01',
      itemReturns: [
        {
          item_id: 'item_1',
          quantity_to_return: 175000,
          disposition: 'RESTOCK_SELLABLE',
        },
      ],
    });
    expect(validSecondReturn.stockMovementsToExecute[0].quantity_delta).toBe(175000);
  });
});



