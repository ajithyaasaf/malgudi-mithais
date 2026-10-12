import { describe, it, expect } from 'vitest';
import { 
  createStockReservation, 
  calculateAvailableStock, 
  commitReservations, 
  releaseReservations, 
  expireStaleReservations, 
  validateStockReversalJustification,
  getReservationScopePolicy,
  atomicCommitReservation,
  recoverReservationsAfterRestart
} from '../src/reservations.js';

describe('Explicit Stock Reservations & Available Inventory Invariants', () => {
  const branchId = 'IB';
  const productId = 'prod_laddu';
  const initialPhysicalStock = 1000000; // 1,000,000 mg (1 kg) on hand

  it('Creates an active stock reservation with 15-minute TTL', () => {
    const res = createStockReservation({
      cartOrSaleId: 'cart_101',
      branchId,
      productId,
      quantity: 250000, // 250g
      unit: 'MG',
    });

    expect(res.status).toBe('ACTIVE');
    expect(res.reserved_quantity).toBe(250000);
    expect(new Date(res.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('Calculates available stock as physical stock minus active unexpired reservations', () => {
    const res1 = createStockReservation({
      cartOrSaleId: 'cart_1',
      branchId,
      productId,
      quantity: 250000, // 250g
      unit: 'MG',
    });
    const res2 = createStockReservation({
      cartOrSaleId: 'cart_2',
      branchId,
      productId,
      quantity: 350000, // 350g
      unit: 'MG',
    });

    const available = calculateAvailableStock(initialPhysicalStock, [res1, res2], productId);
    // 1,000,000 - 250,000 - 350,000 = 400,000 mg available
    expect(available).toBe(400000);
  });

  it('Ignores expired reservations when calculating available stock', () => {
    const activeRes = createStockReservation({
      cartOrSaleId: 'cart_active',
      branchId,
      productId,
      quantity: 200000,
      unit: 'MG',
    });
    const expiredRes = {
      ...createStockReservation({
        cartOrSaleId: 'cart_expired',
        branchId,
        productId,
        quantity: 500000,
        unit: 'MG',
      }),
      expires_at: new Date(Date.now() - 60000).toISOString(), // Expired 1 min ago
    };

    const available = calculateAvailableStock(initialPhysicalStock, [activeRes, expiredRes], productId);
    // Expired reservation is ignored; only active 200g deducted
    expect(available).toBe(800000);
  });

  it('Commits reservations into formal SALE_DEDUCTION stock movements upon checkout', () => {
    const res = createStockReservation({
      cartOrSaleId: 'cart_commit',
      branchId,
      productId,
      quantity: 500000,
      unit: 'MG',
    });

    const { updatedReservations, stockMovements } = commitReservations([res], 'sale_001');

    expect(updatedReservations[0].status).toBe('COMMITTED');
    expect(stockMovements).toHaveLength(1);
    expect(stockMovements[0]).toEqual({
      id: `sm_${res.id}`,
      branch_id: branchId,
      product_id: productId,
      movement_type: 'SALE_DEDUCTION',
      quantity_delta: -500000, // Negative deduction
      unit: 'MG',
      reference_id: 'sale_001',
      created_at: expect.any(String),
    });
  });

  it('Releases reservations when cart is cleared or sale is aborted', () => {
    const res = createStockReservation({
      cartOrSaleId: 'cart_cancel',
      branchId,
      productId,
      quantity: 300000,
      unit: 'MG',
    });

    const released = releaseReservations([res]);
    expect(released[0].status).toBe('RELEASED');

    // Available stock immediately restores
    const available = calculateAvailableStock(initialPhysicalStock, released, productId);
    expect(available).toBe(initialPhysicalStock);
  });

  it('Prevents race condition: Rejects committing reservation that expired before checkout completed', () => {
    const expiredRes = {
      ...createStockReservation({
        cartOrSaleId: 'cart_race',
        branchId,
        productId,
        quantity: 300000,
        unit: 'MG',
      }),
      expires_at: new Date(Date.now() - 5000).toISOString(), // Expired 5 seconds ago!
    };

    expect(() => {
      commitReservations([expiredRes], 'sale_race');
    }).toThrow(/Reservation expired/);
  });

  describe('Reservation Scope & Air-Gapped Coordination Policy', () => {
    it('Defines BRANCH_LAN scope when LAN is connected and acknowledges disconnected limitations', () => {
      const onlinePolicy = getReservationScopePolicy(true);
      expect(onlinePolicy.scope).toBe('BRANCH_LAN');
      expect(onlinePolicy.canCoordinateCrossTerminal).toBe(true);

      const offlinePolicy = getReservationScopePolicy(false);
      expect(offlinePolicy.scope).toBe('TERMINAL_LOCAL');
      expect(offlinePolicy.canCoordinateCrossTerminal).toBe(false);
      expect(offlinePolicy.disconnectionLimitation).toContain('Air-gapped offline terminals cannot prevent concurrent inventory over-selling');
    });
  });

  describe('Concurrency Safety & Atomic Lifecycle Invariants', () => {
    it('Prevents double deductions on repeated finalization calls (Idempotent Commit)', () => {
      const res = createStockReservation({
        cartOrSaleId: 'cart_dup',
        branchId,
        productId,
        quantity: 250000,
        unit: 'MG',
      });

      // First commit succeeds
      const firstCommit = atomicCommitReservation(res, 'sale_dup_1');
      expect(firstCommit.updatedReservation.status).toBe('COMMITTED');
      expect(firstCommit.isAlreadyCommitted).toBe(false);
      expect(firstCommit.stockMovement.quantity_delta).toBe(-250000);

      // Repeated finalization call with already COMMITTED reservation must NOT create second deduction
      const secondCommit = atomicCommitReservation(firstCommit.updatedReservation, 'sale_dup_1');
      expect(secondCommit.updatedReservation.status).toBe('COMMITTED');
      expect(secondCommit.isAlreadyCommitted).toBe(true);
    });

    it('Concurrency guard: Expiry worker cannot expire a reservation that has already been committed', () => {
      const res = createStockReservation({
        cartOrSaleId: 'cart_race',
        branchId,
        productId,
        quantity: 200000,
        unit: 'MG',
      });

      // Checkout completes first
      const { updatedReservation } = atomicCommitReservation(res, 'sale_race');
      expect(updatedReservation.status).toBe('COMMITTED');

      // Expiry worker runs later with lapsed timestamp
      const expiredList = expireStaleReservations([updatedReservation], Date.now() + 1000000);
      expect(expiredList[0].status).toBe('COMMITTED'); // Preserved COMMITTED!
    });

    it('Concurrency guard: Finalization cannot commit an expired or released reservation', () => {
      const activeRes = createStockReservation({
        cartOrSaleId: 'cart_rel',
        branchId,
        productId,
        quantity: 100000,
        unit: 'MG',
      });
      const released = releaseReservations([activeRes])[0];

      expect(() => {
        atomicCommitReservation(released, 'sale_rel');
      }).toThrow(/must be 'ACTIVE'/);

      const expiredRes = {
        ...activeRes,
        status: 'EXPIRED' as const,
      };
      expect(() => {
        atomicCommitReservation(expiredRes, 'sale_exp');
      }).toThrow(/must be 'ACTIVE'/);
    });

    it('Recovers reservations after application restart: active unexpired kept, expired during downtime updated', () => {
      const now = Date.now();
      const persisted = [
        {
          ...createStockReservation({ cartOrSaleId: 'c1', branchId, productId, quantity: 100000, unit: 'MG' as const }),
          expires_at: new Date(now + 600000).toISOString(), // Unexpired (10 min left)
          status: 'ACTIVE' as const,
        },
        {
          ...createStockReservation({ cartOrSaleId: 'c2', branchId, productId, quantity: 200000, unit: 'MG' as const }),
          expires_at: new Date(now - 10000).toISOString(), // Expired 10s ago during downtime
          status: 'ACTIVE' as const,
        },
        {
          ...createStockReservation({ cartOrSaleId: 'c3', branchId, productId, quantity: 300000, unit: 'MG' as const }),
          expires_at: new Date(now + 300000).toISOString(),
          status: 'COMMITTED' as const, // Already committed before shutdown
        },
      ];

      const report = recoverReservationsAfterRestart(persisted, now);
      expect(report.activeReservations).toHaveLength(1);
      expect(report.activeReservations[0].cart_or_sale_id).toBe('c1');

      expect(report.expiredReservations).toHaveLength(1);
      expect(report.expiredReservations[0].cart_or_sale_id).toBe('c2');
      expect(report.expiredReservations[0].status).toBe('EXPIRED');

      // COMMITTED remains COMMITTED
      const committed = report.allRecovered.find(r => r.cart_or_sale_id === 'c3')!;
      expect(committed.status).toBe('COMMITTED');
    });

    it('Simultaneous reservation attempts: accurately reduces available stock across multiple carts', () => {
      const totalInventory = 1000000; // 1,000,000 mg (1 kg)
      const resA = createStockReservation({ cartOrSaleId: 'cart_A', branchId, productId, quantity: 400000, unit: 'MG' });
      const resB = createStockReservation({ cartOrSaleId: 'cart_B', branchId, productId, quantity: 350000, unit: 'MG' });

      const availAfterA = calculateAvailableStock(totalInventory, [resA], productId);
      expect(availAfterA).toBe(600000);

      const availAfterBoth = calculateAvailableStock(totalInventory, [resA, resB], productId);
      expect(availAfterBoth).toBe(250000);

      // Attempting to reserve 300g when only 250g available is detected by inventory check
      expect(availAfterBoth < 300000).toBe(true);
    });
  });

  describe('Truthful Reversal Justification Invariant', () => {
    it('Validates positive restock when prior deduction justifies it', () => {
      const priorDeductionDelta = -375000; // Prior sale of 375g
      const attemptedRestore = 375000;

      expect(validateStockReversalJustification(priorDeductionDelta, attemptedRestore)).toBe(true);
    });

    it('Rejects positive restock when no prior negative deduction exists', () => {
      const zeroPriorDeduction = 0; // E.g., service item or phantom return
      expect(() => {
        validateStockReversalJustification(zeroPriorDeduction, 100000);
      }).toThrow(/No prior negative stock deduction/);
    });

    it('Rejects positive restock exceeding prior sale quantity', () => {
      const priorDeductionDelta = -250000; // Sold 250g
      const excessiveRestore = 500000;     // Attempt to restock 500g!

      expect(() => {
        validateStockReversalJustification(priorDeductionDelta, excessiveRestore);
      }).toThrow(/exceeds unreversed quantity/);
    });

    it('Rejects cumulative partial returns exceeding original unreversed quantity', () => {
      const priorDeductionDelta = -375000; // Sold 375g
      const cumulativeAlreadyRestocked = 200000; // 200g already returned
      const attemptedSecondRestore = 200000; // 200g + 200g = 400g > 375g!

      expect(() => {
        validateStockReversalJustification(priorDeductionDelta, attemptedSecondRestore, cumulativeAlreadyRestocked);
      }).toThrow(/exceeds unreversed quantity/);

      // Remaining 175g must succeed
      expect(validateStockReversalJustification(priorDeductionDelta, 175000, cumulativeAlreadyRestocked)).toBe(true);
    });
  });
});

