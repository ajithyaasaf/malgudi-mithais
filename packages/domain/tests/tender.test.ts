import { describe, it, expect } from 'vitest';
import { PaymentTenderAllocation } from '@malgudi/contracts';
import { 
  validateAndReconcileSplitTender,
  evaluateTransactionPaymentLifecycle,
  abortPartialCollection,
  reconcileUnknownPayment,
  calculateDetailedFinancialBreakdown,
  initiateDigitalRefund,
  updateDigitalRefundStatus,
  handlePaymentSuccessWithExpiredReservation
} from '../src/tender.js';

describe('Split Tender Invariants & Cash Drawer Reconciliation', () => {
  it('Validates exact ₹255 bill: ₹155 Cash + ₹100 UPI -> Drawer increases by exactly ₹155', () => {
    const requiredTotalPaise = 25500; // ₹255.00

    const allocations: PaymentTenderAllocation[] = [
      {
        id: 'pay_cash_1',
        payment_method: 'CASH',
        allocated_amount_paise: 15500, // ₹155.00
        tendered_paise: 20000,         // ₹200.00 currency note
        change_returned_paise: 4500,   // ₹45.00 change returned
        net_amount_paise: 15500,       // ₹155.00 retained
        outcome: 'SUCCESS',
      },
      {
        id: 'pay_upi_1',
        payment_method: 'UPI_MANUAL_RECORDED',
        allocated_amount_paise: 10000, // ₹100.00
        tendered_paise: 10000,
        change_returned_paise: 0,
        net_amount_paise: 10000,
        outcome: 'SUCCESS',
        verified_by_user_id: 'cashier_01',
      },
    ];

    const result = validateAndReconcileSplitTender(requiredTotalPaise, allocations);

    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.totalAllocatedPaise).toBe(25500);

    // The physical cash drawer increases strictly by the net cash retained!
    expect(result.totalNetCashDrawerPaise).toBe(15500);

    // Exactly ONE cash movement generated
    expect(result.cashMovementsToCreate).toHaveLength(1);
    expect(result.cashMovementsToCreate[0]).toEqual({
      movement_type: 'CASH_SALE',
      amount_paise: 15500,
      direction: 'IN',
    });
  });

  it('Rejects over-tendered cash when change returned does not match calculation', () => {
    const requiredTotalPaise = 25500;

    const allocations: PaymentTenderAllocation[] = [
      {
        id: 'pay_cash_invalid_change',
        payment_method: 'CASH',
        allocated_amount_paise: 25500,
        tendered_paise: 50000,       // Gave ₹500 note
        change_returned_paise: 20000, // Error: gave ₹200 change instead of ₹245!
        net_amount_paise: 25500,
        outcome: 'SUCCESS',
      },
    ];

    const result = validateAndReconcileSplitTender(requiredTotalPaise, allocations);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('Change returned'))).toBe(true);
  });

  it('Rejects non-cash tender that attempts to return cash change', () => {
    const requiredTotalPaise = 10000;

    const allocations: PaymentTenderAllocation[] = [
      {
        id: 'pay_upi_fraud',
        payment_method: 'UPI_GATEWAY_DYNAMIC',
        allocated_amount_paise: 10000,
        tendered_paise: 15000,
        change_returned_paise: 5000, // Non-cash cannot return cash change!
        net_amount_paise: 10000,
        outcome: 'SUCCESS',
      },
    ];

    const result = validateAndReconcileSplitTender(requiredTotalPaise, allocations);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('Change cannot be returned for non-cash'))).toBe(true);
  });

  it('Rejects tender when total allocation does not equal required bill total (partial payment)', () => {
    const requiredTotalPaise = 25500;

    const allocations: PaymentTenderAllocation[] = [
      {
        id: 'pay_partial',
        payment_method: 'CASH',
        allocated_amount_paise: 15500, // Short by ₹100
        tendered_paise: 20000,
        change_returned_paise: 4500,
        net_amount_paise: 15500,
        outcome: 'SUCCESS',
      },
    ];

    const result = validateAndReconcileSplitTender(requiredTotalPaise, allocations);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('does not match required bill total'))).toBe(true);
  });

  it('Rejects duplicate cash payment entries in a single bill to prevent duplicate drawer entries', () => {
    const requiredTotalPaise = 20000;

    const allocations: PaymentTenderAllocation[] = [
      {
        id: 'pay_cash_1',
        payment_method: 'CASH',
        allocated_amount_paise: 10000,
        tendered_paise: 10000,
        change_returned_paise: 0,
        net_amount_paise: 10000,
        outcome: 'SUCCESS',
      },
      {
        id: 'pay_cash_2',
        payment_method: 'CASH',
        allocated_amount_paise: 10000,
        tendered_paise: 10000,
        change_returned_paise: 0,
        net_amount_paise: 10000,
        outcome: 'SUCCESS',
      },
    ];

    const result = validateAndReconcileSplitTender(requiredTotalPaise, allocations);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('Multiple cash tenders detected'))).toBe(true);
  });

  it('Rejects change returned exceeding the tendered cash amount', () => {
    const requiredTotalPaise = 10000;

    const allocations: PaymentTenderAllocation[] = [
      {
        id: 'pay_cash_excess_change',
        payment_method: 'CASH',
        allocated_amount_paise: 10000,
        tendered_paise: 10000,
        change_returned_paise: 15000, // Return ₹150 change on ₹100 tender!
        net_amount_paise: 10000,
        outcome: 'SUCCESS',
      },
    ];

    const result = validateAndReconcileSplitTender(requiredTotalPaise, allocations);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.includes('Change returned cannot exceed tendered cash') || e.includes('Change returned'))).toBe(true);
  });

  describe('Transaction Payment Lifecycle & Partial Collection Reconciliation', () => {
    const requiredTotalPaise = 25500;

    it('Derives DRAFT status when zero payments have been recorded', () => {
      const evalResult = evaluateTransactionPaymentLifecycle(requiredTotalPaise, []);
      expect(evalResult.derivedSaleStatus).toBe('DRAFT');
      expect(evalResult.derivedPaymentStatus).toBe('UNSETTLED_PENDING');
      expect(evalResult.canFinalizeAndCommit).toBe(false);
      expect(evalResult.remainingBalancePaise).toBe(25500);
    });

    it('Derives PARTIALLY_COLLECTED when partial cash is collected durably without marking sale settled', () => {
      const recorded: PaymentTenderAllocation[] = [
        {
          id: 'pay_partial_cash',
          payment_method: 'CASH',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        },
      ];

      const evalResult = evaluateTransactionPaymentLifecycle(requiredTotalPaise, recorded);
      expect(evalResult.derivedSaleStatus).toBe('PARTIALLY_COLLECTED');
      expect(evalResult.derivedPaymentStatus).toBe('PARTIALLY_SETTLED');
      expect(evalResult.totalCollectedPaise).toBe(10000);
      expect(evalResult.remainingBalancePaise).toBe(15500);
      expect(evalResult.canFinalizeAndCommit).toBe(false);
    });

    it('Blocks finalization when dynamic UPI times out into TIMEOUT_UNKNOWN outcome', () => {
      const recorded: PaymentTenderAllocation[] = [
        {
          id: 'pay_cash',
          payment_method: 'CASH',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        },
        {
          id: 'pay_upi_timeout',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 15500,
          tendered_paise: 15500,
          change_returned_paise: 0,
          net_amount_paise: 15500,
          outcome: 'TIMEOUT_UNKNOWN', // Gateway pending!
        },
      ];

      const evalResult = evaluateTransactionPaymentLifecycle(requiredTotalPaise, recorded);
      expect(evalResult.hasUnknownOutcomes).toBe(true);
      expect(evalResult.canFinalizeAndCommit).toBe(false);
      expect(evalResult.errors.some(e => e.includes('TIMEOUT_UNKNOWN'))).toBe(true);
    });

    it('Permits finalization and marks COMPLETED / SETTLED only when 100% is reconciled successfully', () => {
      const recorded: PaymentTenderAllocation[] = [
        {
          id: 'pay_cash',
          payment_method: 'CASH',
          allocated_amount_paise: 15500,
          tendered_paise: 20000,
          change_returned_paise: 4500,
          net_amount_paise: 15500,
          outcome: 'SUCCESS',
        },
        {
          id: 'pay_upi',
          payment_method: 'UPI_MANUAL_RECORDED',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        },
      ];

      const evalResult = evaluateTransactionPaymentLifecycle(requiredTotalPaise, recorded);
      expect(evalResult.derivedSaleStatus).toBe('COMPLETED');
      expect(evalResult.derivedPaymentStatus).toBe('SETTLED');
      expect(evalResult.canFinalizeAndCommit).toBe(true);
      expect(evalResult.remainingBalancePaise).toBe(0);
    });

    it('Aborting a partially collected transaction refunds strictly the received cash with exactly one movement', () => {
      const recorded: PaymentTenderAllocation[] = [
        {
          id: 'pay_cash',
          payment_method: 'CASH',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        },
        {
          id: 'pay_upi_failed',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 15500,
          tendered_paise: 15500,
          change_returned_paise: 0,
          net_amount_paise: 15500,
          outcome: 'FAILED',
        },
      ];

      const abortPlan = abortPartialCollection(recorded, 'supervisor_01', 'UPI gateway failed');
      expect(abortPlan.updatedSaleStatus).toBe('CANCELLED_ABORTED');
      expect(abortPlan.updatedPaymentStatus).toBe('REFUNDED');
      expect(abortPlan.refundCashMovement).toBeDefined();
      expect(abortPlan.refundCashMovement?.amount_paise).toBe(10000);
      expect(abortPlan.refundCashMovement?.movement_type).toBe('CASH_REFUND');
      expect(abortPlan.refundCashMovement?.direction).toBe('OUT');
    });

    it('Correctly preserves TIMEOUT_UNKNOWN outcome upon cancellation without falsely marking it REFUNDED', () => {
      const recorded: PaymentTenderAllocation[] = [
        {
          id: 'pay_cash_collected',
          payment_method: 'CASH',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        },
        {
          id: 'pay_upi_unresolved',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 15500,
          tendered_paise: 15500,
          change_returned_paise: 0,
          net_amount_paise: 15500,
          outcome: 'TIMEOUT_UNKNOWN', // Bank outcome not yet confirmed!
        },
      ];

      const abortPlan = abortPartialCollection(recorded, 'supervisor_01', 'Customer cannot wait for UPI resolution');
      expect(abortPlan.updatedSaleStatus).toBe('CANCELLED_ABORTED');
      expect(abortPlan.hasUnresolvedUnknownUPI).toBe(true);
      // Invariant: Because UPI outcome is unresolved, overall payment status is UNSETTLED_PENDING until reconciled
      expect(abortPlan.updatedPaymentStatus).toBe('UNSETTLED_PENDING');
      
      // Cash was returned
      expect(abortPlan.refundCashMovement?.amount_paise).toBe(10000);
      
      // The UPI payment MUST NOT be marked REFUNDED yet!
      const upiPayment = abortPlan.updatedPayments.find(p => p.id === 'pay_upi_unresolved')!;
      expect(upiPayment.outcome).toBe('TIMEOUT_UNKNOWN');
    });

    it('Idempotently reconciles unknown payment: triggers digital refund if bank debited customer for aborted sale', () => {
      const pendingPayment: PaymentTenderAllocation = {
        id: 'pay_upi_unresolved',
        payment_method: 'UPI_GATEWAY_DYNAMIC',
        allocated_amount_paise: 15500,
        tendered_paise: 15500,
        change_returned_paise: 0,
        net_amount_paise: 15500,
        outcome: 'TIMEOUT_UNKNOWN',
      };

      // Scenario A: Bank confirmed customer was debited (SUCCESS) for a sale that was already aborted
      const res = reconcileUnknownPayment(pendingPayment, 'SUCCESS', true);
      expect(res.updatedPayment.outcome).toBe('SUCCESS');
      expect(res.requiresDigitalRefund).toBe(true);
      expect(res.updatedPayment.reconciled_disposition).toBe('UNSOLICITED_GATEWAY_SUCCESS_AUTO_REFUND');

      // Idempotent retry: Reconciling again does not duplicate actions
      const idempotentRes = reconcileUnknownPayment(res.updatedPayment, 'SUCCESS', true);
      expect(idempotentRes.requiresDigitalRefund).toBe(false);
      expect(idempotentRes.actionTaken).toContain('Idempotent no-op');
    });

    it('Accurately computes detailed financial breakdown distinguishing gross cash, change, net received, confirmed non-cash, and refunds', () => {
      const payments: PaymentTenderAllocation[] = [
        {
          id: 'pay_cash',
          payment_method: 'CASH',
          allocated_amount_paise: 15500,
          tendered_paise: 20000, // ₹200 note
          change_returned_paise: 4500,
          net_amount_paise: 15500,
          outcome: 'SUCCESS',
        },
        {
          id: 'pay_upi',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        },
      ];

      const refundMovements = [{ amount_paise: 5000, direction: 'OUT' as const }];
      const digitalRefunds = [
        {
          id: 'ref_1',
          payment_id: 'pay_upi_old',
          sale_id: 'sale_old',
          amount_paise: 2000,
          status: 'SUCCESS' as const,
          retry_count: 0,
          initiated_at: '2026-10-10T10:00:00Z',
        },
        {
          id: 'ref_2',
          payment_id: 'pay_upi_pending',
          sale_id: 'sale_old_2',
          amount_paise: 3000,
          status: 'PENDING_GATEWAY' as const,
          retry_count: 0,
          initiated_at: '2026-10-10T10:05:00Z',
        },
      ];

      const breakdown = calculateDetailedFinancialBreakdown(25500, payments, refundMovements, digitalRefunds);

      expect(breakdown.netPayablePaise).toBe(25500);
      expect(breakdown.grossTenderedCashPaise).toBe(20000);
      expect(breakdown.changeReturnedPaise).toBe(4500);
      expect(breakdown.netPhysicalCashReceivedPaise).toBe(15500);
      expect(breakdown.gatewayConfirmedNonCashPaise).toBe(10000);
      expect(breakdown.outstandingBalancePaise).toBe(0);
      expect(breakdown.cashRefundsPaise).toBe(5000);
      expect(breakdown.digitalRefundsConfirmedPaise).toBe(2000);
      expect(breakdown.digitalRefundsPendingPaise).toBe(3000);
      // Compatibility aliases
      expect(breakdown.moneyTenderedPaise).toBe(30000);
      expect(breakdown.moneyActuallyReceivedPaise).toBe(25500);
    });

    it('Tracks digital refund lifecycle: initiation does not imply receipt, handles success, failures and retries', () => {
      const refund = initiateDigitalRefund({
        paymentId: 'pay_upi_abc',
        saleId: 'sale_123',
        amountPaise: 10000,
        customerVpa: 'customer@upi',
      });

      // 1. Invariant: Initiation is strictly INITIATED, never SUCCESS
      expect(refund.status).toBe('INITIATED');
      expect(refund.retry_count).toBe(0);

      // 2. Failure event: Gateway returns temporary decline
      const failedRefund = updateDigitalRefundStatus(refund, {
        status: 'FAILED',
        failureReason: 'Bank switch timeout',
      });
      expect(failedRefund.status).toBe('FAILED');
      expect(failedRefund.failure_reason).toBe('Bank switch timeout');
      expect(failedRefund.retry_count).toBe(1);

      // 3. Retry succeeds
      const successRefund = updateDigitalRefundStatus(failedRefund, {
        status: 'SUCCESS',
        gatewayReference: 'UTR_REF_998877',
      });
      expect(successRefund.status).toBe('SUCCESS');
      expect(successRefund.gateway_reference).toBe('UTR_REF_998877');
      expect(successRefund.completed_at).toBeDefined();

      // 4. Idempotency: Duplicate webhook callback for SUCCESS is a safe no-op
      const duplicateCallback = updateDigitalRefundStatus(successRefund, {
        status: 'SUCCESS',
        gatewayReference: 'UTR_REF_998877',
      });
      expect(duplicateCallback.status).toBe('SUCCESS');
      expect(duplicateCallback.completed_at).toBe(successRefund.completed_at);
    });

    it('Handles late payment success after reservation expires: fulfills if stock available, refunds if stock exhausted', () => {
      const latePayment: PaymentTenderAllocation = {
        id: 'pay_late_upi',
        payment_method: 'UPI_GATEWAY_DYNAMIC',
        allocated_amount_paise: 25500,
        tendered_paise: 25500,
        change_returned_paise: 0,
        net_amount_paise: 25500,
        outcome: 'TIMEOUT_UNKNOWN',
      };

      // Scenario A: Customer paid after reservation expired, but physical shelf still has available stock
      const resStockAvailable = handlePaymentSuccessWithExpiredReservation({
        payment: latePayment,
        saleId: 'sale_expired_res_1',
        requiredQuantity: 375000,
        availableStock: 500000, // 500g available
      });
      expect(resStockAvailable.resolution).toBe('RE_RESERVED_AND_FULFILLABLE');
      expect(resStockAvailable.payment.outcome).toBe('SUCCESS');
      expect(resStockAvailable.payment.reconciled_disposition).toBe('LATE_PAYMENT_ACCEPTED_STOCK_RE_RESERVED');
      expect(resStockAvailable.refundRecord).toBeUndefined();

      // Scenario B: Customer paid after reservation expired, and item is completely out of stock
      const resStockExhausted = handlePaymentSuccessWithExpiredReservation({
        payment: latePayment,
        saleId: 'sale_expired_res_2',
        requiredQuantity: 375000,
        availableStock: 0, // Out of stock!
        customerVpa: 'customer@okaxis',
      });
      expect(resStockExhausted.resolution).toBe('STOCK_EXHAUSTED_REFUND_REQUIRED');
      expect(resStockExhausted.payment.outcome).toBe('SUCCESS'); // Payment preserved!
      expect(resStockExhausted.payment.reconciled_disposition).toBe('LATE_PAYMENT_OUT_OF_STOCK_REFUND_INITIATED');
      expect(resStockExhausted.refundRecord).toBeDefined();
      expect(resStockExhausted.refundRecord?.status).toBe('INITIATED');
      expect(resStockExhausted.refundRecord?.amount_paise).toBe(25500);
      expect(resStockExhausted.refundRecord?.customer_vpa).toBe('customer@okaxis');
    });

    describe('Priority 1 Invariant Regression Suite — Split Tender, Cashier Assertion vs Gateway Confirmation, and Refunds', () => {
      const requiredTotalPaise = 25500; // ₹255.00

      it('1. ₹155 net cash plus ₹100 confirmed UPI -> Drawer increases by exactly ₹155, zero outstanding balance, COMPLETED/SETTLED', () => {
        const allocations: PaymentTenderAllocation[] = [
          {
            id: 'pay_cash_155',
            payment_method: 'CASH',
            allocated_amount_paise: 15500,
            tendered_paise: 20000,       // ₹200 note
            change_returned_paise: 4500, // ₹45 change
            net_amount_paise: 15500,     // Net physical cash retained
            outcome: 'SUCCESS',
            verification_source: 'PHYSICAL_CASH_DRAWER',
          },
          {
            id: 'pay_upi_100_confirmed',
            payment_method: 'UPI_GATEWAY_DYNAMIC',
            allocated_amount_paise: 10000,
            tendered_paise: 10000,
            change_returned_paise: 0,
            net_amount_paise: 10000,
            outcome: 'SUCCESS',
            verification_source: 'GATEWAY_API',
            is_gateway_confirmed: true,
          },
        ];

        // A. Tender Invariant Check
        const tenderRes = validateAndReconcileSplitTender(requiredTotalPaise, allocations);
        expect(tenderRes.isValid).toBe(true);
        expect(tenderRes.totalNetCashDrawerPaise).toBe(15500); // Net cash retained is ₹155, NOT ₹200!
        expect(tenderRes.cashMovementsToCreate).toHaveLength(1);
        expect(tenderRes.cashMovementsToCreate[0].amount_paise).toBe(15500);

        // B. Detailed Breakdown Check
        const breakdown = calculateDetailedFinancialBreakdown(requiredTotalPaise, allocations);
        expect(breakdown.grossTenderedCashPaise).toBe(20000);
        expect(breakdown.changeReturnedPaise).toBe(4500);
        expect(breakdown.netPhysicalCashReceivedPaise).toBe(15500);
        expect(breakdown.gatewayConfirmedNonCashPaise).toBe(10000);
        expect(breakdown.unverifiedNonCashPaise).toBe(0);
        expect(breakdown.outstandingBalancePaise).toBe(0);

        // C. Lifecycle Settlement under STRICT_GATEWAY_ONLY
        const strictEval = evaluateTransactionPaymentLifecycle(requiredTotalPaise, allocations, 'STRICT_GATEWAY_ONLY');
        expect(strictEval.derivedSaleStatus).toBe('COMPLETED');
        expect(strictEval.derivedPaymentStatus).toBe('SETTLED');
        expect(strictEval.canFinalizeAndCommit).toBe(true);
        expect(strictEval.remainingBalancePaise).toBe(0);
      });

      it('2. ₹155 net cash plus ₹100 unverified UPI -> Outstanding balance is ₹100, blocks completion under STRICT_GATEWAY_ONLY', () => {
        const allocations: PaymentTenderAllocation[] = [
          {
            id: 'pay_cash_155',
            payment_method: 'CASH',
            allocated_amount_paise: 15500,
            tendered_paise: 20000,
            change_returned_paise: 4500,
            net_amount_paise: 15500,
            outcome: 'SUCCESS',
            verification_source: 'PHYSICAL_CASH_DRAWER',
          },
          {
            id: 'pay_upi_100_unverified',
            payment_method: 'UPI_MANUAL_RECORDED', // Cashier assertion without gateway API
            allocated_amount_paise: 10000,
            tendered_paise: 10000,
            change_returned_paise: 0,
            net_amount_paise: 10000,
            outcome: 'SUCCESS', // Cashier recorded success visually
            verification_source: 'CASHIER_UNVERIFIED_CLAIM',
            is_gateway_confirmed: false,
            reference_note: 'Customer showed phone screen',
          },
        ];

        // A. Tender Invariant: Cash drawer still strictly receives net ₹155
        const tenderRes = validateAndReconcileSplitTender(requiredTotalPaise, allocations);
        expect(tenderRes.isValid).toBe(true);
        expect(tenderRes.totalNetCashDrawerPaise).toBe(15500);

        // B. Breakdown distinguishes unverified non-cash
        const breakdown = calculateDetailedFinancialBreakdown(requiredTotalPaise, allocations);
        expect(breakdown.netPhysicalCashReceivedPaise).toBe(15500);
        expect(breakdown.gatewayConfirmedNonCashPaise).toBe(0);
        expect(breakdown.unverifiedNonCashPaise).toBe(10000);
        expect(breakdown.outstandingBalancePaise).toBe(10000); // Exactly ₹100 outstanding unverified!

        // C. STRICT policy rejects settlement without gateway proof
        const strictEval = evaluateTransactionPaymentLifecycle(requiredTotalPaise, allocations, 'STRICT_GATEWAY_ONLY');
        expect(strictEval.derivedSaleStatus).toBe('PARTIALLY_COLLECTED');
        expect(strictEval.derivedPaymentStatus).toBe('PARTIALLY_SETTLED');
        expect(strictEval.canFinalizeAndCommit).toBe(false);
        expect(strictEval.hasUnverifiedClaims).toBe(true);
        expect(strictEval.remainingBalancePaise).toBe(10000);
        expect(strictEval.errors.some(e => e.includes('STRICT_GATEWAY_ONLY'))).toBe(true);
      });

      it('3. UPI timeout followed by gateway success -> Reconciles to SUCCESS, settles sale without duplicate drawer movement', () => {
        const timeoutPayment: PaymentTenderAllocation = {
          id: 'pay_upi_timeout_1',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'TIMEOUT_UNKNOWN',
        };

        // When sale is still active (not aborted)
        const reconciliation = reconcileUnknownPayment(timeoutPayment, 'SUCCESS', false, undefined, 'sale_madurai_01');
        expect(reconciliation.updatedPayment.outcome).toBe('SUCCESS');
        expect(reconciliation.requiresDigitalRefund).toBe(false);
        expect(reconciliation.actionTaken).toContain('settled towards sale');
      });

      it('4. UPI timeout followed by gateway failure -> Reconciles to FAILED, zero digital refund, preserves net cash drawer', () => {
        const timeoutPayment: PaymentTenderAllocation = {
          id: 'pay_upi_timeout_2',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'TIMEOUT_UNKNOWN',
        };

        const reconciliation = reconcileUnknownPayment(timeoutPayment, 'FAILED', false, undefined, 'sale_madurai_02');
        expect(reconciliation.updatedPayment.outcome).toBe('FAILED');
        expect(reconciliation.requiresDigitalRefund).toBe(false);
      });

      it('5. Duplicate payment confirmation -> Reconciling an already-resolved payment is a safe idempotent no-op', () => {
        const resolvedPayment: PaymentTenderAllocation = {
          id: 'pay_upi_resolved',
          payment_method: 'UPI_GATEWAY_DYNAMIC',
          allocated_amount_paise: 10000,
          tendered_paise: 10000,
          change_returned_paise: 0,
          net_amount_paise: 10000,
          outcome: 'SUCCESS',
        };

        const secondReconciliation = reconcileUnknownPayment(resolvedPayment, 'SUCCESS', false);
        expect(secondReconciliation.requiresDigitalRefund).toBe(false);
        expect(secondReconciliation.actionTaken).toContain('Idempotent no-op');
      });

      it('6. Duplicate refund initiation -> Repeated initiation with same idempotency key returns existing record without duplicating', () => {
        const refund1 = initiateDigitalRefund({
          paymentId: 'pay_upi_dup_ref',
          saleId: 'sale_dup_ref',
          amountPaise: 10000,
          customerVpa: 'cust@upi',
          idempotencyKey: 'idemp_refund_unique_7788',
        });

        const refund2 = initiateDigitalRefund({
          paymentId: 'pay_upi_dup_ref',
          saleId: 'sale_dup_ref',
          amountPaise: 10000,
          customerVpa: 'cust@upi',
          idempotencyKey: 'idemp_refund_unique_7788',
          existingRefunds: [refund1],
        });

        expect(refund2.id).toBe(refund1.id);
        expect(refund2.idempotency_key).toBe(refund1.idempotency_key);
      });

      it('7. Refund accepted by gateway but response lost -> Status inquiry / retry updates with gateway reference idempotently', () => {
        const initialRefund = initiateDigitalRefund({
          paymentId: 'pay_upi_lost_ack',
          saleId: 'sale_lost_ack',
          amountPaise: 10000,
          customerVpa: 'cust@upi',
        });
        expect(initialRefund.status).toBe('INITIATED');

        // Gateway processed it, but initial HTTP response was lost; background status polling inquiries gateway
        const verifiedRefund = updateDigitalRefundStatus(initialRefund, {
          status: 'SUCCESS',
          gatewayReference: 'BANK_UTR_88990011',
        });
        expect(verifiedRefund.status).toBe('SUCCESS');
        expect(verifiedRefund.gateway_reference).toBe('BANK_UTR_88990011');
        expect(verifiedRefund.completed_at).toBeDefined();

        // Repeated inquiry leaves completed_at and reference stable
        const repeatInquiry = updateDigitalRefundStatus(verifiedRefund, {
          status: 'SUCCESS',
          gatewayReference: 'BANK_UTR_88990011',
        });
        expect(repeatInquiry.status).toBe('SUCCESS');
        expect(repeatInquiry.completed_at).toBe(verifiedRefund.completed_at);
      });

      it('8. Duplicate refund webhook -> Receiving duplicate SUCCESS webhooks leaves record stable', () => {
        const initialRefund = initiateDigitalRefund({
          paymentId: 'pay_upi_webhook_dup',
          saleId: 'sale_webhook_dup',
          amountPaise: 10000,
        });

        const completedRefund = updateDigitalRefundStatus(initialRefund, {
          status: 'SUCCESS',
          gatewayReference: 'UTR_FIRST_DELIVERY',
        });

        const duplicateWebhook = updateDigitalRefundStatus(completedRefund, {
          status: 'SUCCESS',
          gatewayReference: 'UTR_FIRST_DELIVERY',
        });

        expect(duplicateWebhook.status).toBe('SUCCESS');
        expect(duplicateWebhook.gateway_reference).toBe('UTR_FIRST_DELIVERY');
        expect(duplicateWebhook.completed_at).toBe(completedRefund.completed_at);
      });

      it('9. Cash refund versus digital refund ledger effects -> Cash refund affects physical drawer; digital refund DOES NOT affect cash drawer', () => {
        // Cash abort generates physical cash movement OUT
        const recordedSplit: PaymentTenderAllocation[] = [
          {
            id: 'pay_cash',
            payment_method: 'CASH',
            allocated_amount_paise: 15500,
            tendered_paise: 20000,
            change_returned_paise: 4500,
            net_amount_paise: 15500,
            outcome: 'SUCCESS',
          },
          {
            id: 'pay_upi_timeout',
            payment_method: 'UPI_GATEWAY_DYNAMIC',
            allocated_amount_paise: 10000,
            tendered_paise: 10000,
            change_returned_paise: 0,
            net_amount_paise: 10000,
            outcome: 'TIMEOUT_UNKNOWN',
          },
        ];

        const abortPlan = abortPartialCollection(recordedSplit, 'supervisor_01', 'Aborted after partial cash');
        // Physical cash returned to customer: exactly ₹155 (the net amount retained)
        expect(abortPlan.refundCashMovement).toBeDefined();
        expect(abortPlan.refundCashMovement?.amount_paise).toBe(15500);
        expect(abortPlan.refundCashMovement?.movement_type).toBe('CASH_REFUND');
        expect(abortPlan.refundCashMovement?.direction).toBe('OUT');

        // When UPI later resolves as SUCCESS, digital refund is created to source VPA
        const upiReconciliation = reconcileUnknownPayment(
          recordedSplit[1],
          'SUCCESS',
          true,
          'customer@okaxis',
          'sale_split_aborted'
        );
        expect(upiReconciliation.requiresDigitalRefund).toBe(true);
        expect(upiReconciliation.digitalRefundRecord).toBeDefined();
        expect(upiReconciliation.digitalRefundRecord?.amount_paise).toBe(10000);
        // INVARIANT: Reconciling digital payment NEVER creates a cash drawer movement!
        // Cash drawer is completely untouched by the digital refund.
      });
    });
  });
});




