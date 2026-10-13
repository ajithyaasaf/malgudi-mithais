import { 
  PaymentTenderAllocation, 
  CashMovementType, 
  SaleStatus, 
  SalePaymentStatus, 
  PaymentOutcome, 
  DigitalRefundRecord, 
  SettlementPolicy 
} from '@malgudi/contracts';

export interface SplitTenderValidationResult {
  isValid: boolean;
  errors: string[];
  totalAllocatedPaise: number;
  totalNetCashDrawerPaise: number;
  cashMovementsToCreate: Array<{
    movement_type: CashMovementType;
    amount_paise: number;
    direction: 'IN';
  }>;
}

export function validateAndReconcileSplitTender(
  requiredNetPayablePaise: number,
  allocations: PaymentTenderAllocation[]
): SplitTenderValidationResult {
  const errors: string[] = [];
  let totalAllocatedPaise = 0;
  let totalNetCashDrawerPaise = 0;
  const cashMovementsToCreate: Array<{
    movement_type: CashMovementType;
    amount_paise: number;
    direction: 'IN';
  }> = [];

  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    const prefix = `Payment #${i + 1} (${alloc.payment_method})`;

    if (alloc.allocated_amount_paise <= 0) {
      errors.push(`${prefix}: Allocated amount must be positive`);
    }

    // Net amount must strictly equal allocated amount
    if (alloc.net_amount_paise !== alloc.allocated_amount_paise) {
      errors.push(`${prefix}: Net amount (${alloc.net_amount_paise}) must equal allocated amount (${alloc.allocated_amount_paise})`);
    }

    if (alloc.payment_method === 'CASH') {
      if (alloc.tendered_paise < alloc.allocated_amount_paise) {
        errors.push(`${prefix}: Tendered cash (${alloc.tendered_paise}) cannot be less than allocated amount (${alloc.allocated_amount_paise})`);
      }
      const expectedChange = alloc.tendered_paise - alloc.allocated_amount_paise;
      if (alloc.change_returned_paise !== expectedChange) {
        errors.push(`${prefix}: Change returned (${alloc.change_returned_paise}) must exactly equal tendered minus allocated (${expectedChange})`);
      }
      if (alloc.change_returned_paise > alloc.tendered_paise) {
        errors.push(`${prefix}: Change returned cannot exceed tendered cash`);
      }

      // Cash drawer increases strictly by the net cash retained!
      totalNetCashDrawerPaise += alloc.net_amount_paise;

      cashMovementsToCreate.push({
        movement_type: 'CASH_SALE',
        amount_paise: alloc.net_amount_paise,
        direction: 'IN',
      });
    } else {
      // Non-cash payment (UPI, Card): Change must be zero, tender must equal allocation
      if (alloc.change_returned_paise !== 0) {
        errors.push(`${prefix}: Change cannot be returned for non-cash payment methods`);
      }
      if (alloc.tendered_paise !== alloc.allocated_amount_paise) {
        errors.push(`${prefix}: Non-cash tendered amount must equal allocated amount`);
      }
      // Non-cash DOES NOT generate a cash drawer movement!
    }

    if (alloc.outcome !== 'SUCCESS') {
      errors.push(`${prefix}: Cannot settle bill with payment outcome '${alloc.outcome}'`);
    }

    totalAllocatedPaise += alloc.allocated_amount_paise;
  }

  if (totalAllocatedPaise !== requiredNetPayablePaise) {
    errors.push(`Total payment allocation (${totalAllocatedPaise}) does not match required bill total (${requiredNetPayablePaise})`);
  }

  // Ensure only one cash movement per sale to prevent duplicate drawer records
  if (cashMovementsToCreate.length > 1) {
    errors.push('Multiple cash tenders detected in a single bill; must be consolidated into one net cash allocation');
  }

  return {
    isValid: errors.length === 0,
    errors,
    totalAllocatedPaise,
    totalNetCashDrawerPaise,
    cashMovementsToCreate,
  };
}

export interface DetailedFinancialBreakdown {
  netPayablePaise: number;
  grossTenderedCashPaise: number;
  changeReturnedPaise: number;
  netPhysicalCashReceivedPaise: number;
  gatewayConfirmedNonCashPaise: number;
  unverifiedNonCashPaise: number;
  outstandingBalancePaise: number;
  cashRefundsPaise: number;
  digitalRefundsConfirmedPaise: number;
  digitalRefundsPendingPaise: number;
  // Aliases for compatibility
  moneyTenderedPaise: number;
  moneyActuallyReceivedPaise: number;
  gatewayConfirmedMoneyPaise: number;
  moneyRefundedPaise: number;
}

export function calculateDetailedFinancialBreakdown(
  netPayablePaise: number,
  recordedPayments: PaymentTenderAllocation[],
  refundMovements: Array<{ amount_paise: number; direction: 'OUT' }> = [],
  digitalRefunds: DigitalRefundRecord[] = []
): DetailedFinancialBreakdown {
  let grossTenderedCashPaise = 0;
  let changeReturnedPaise = 0;
  let netPhysicalCashReceivedPaise = 0;
  let gatewayConfirmedNonCashPaise = 0;
  let unverifiedNonCashPaise = 0;

  for (const p of recordedPayments) {
    if (p.payment_method === 'CASH') {
      grossTenderedCashPaise += p.tendered_paise;
      changeReturnedPaise += p.change_returned_paise;
      if (p.outcome === 'SUCCESS') {
        netPhysicalCashReceivedPaise += p.net_amount_paise;
      }
    } else {
      // Non-cash payment (UPI, Card)
      const isGatewayConfirmed = p.outcome === 'SUCCESS' && (
        p.is_gateway_confirmed === true || 
        p.verification_source === 'GATEWAY_API' ||
        (!p.verification_source && p.payment_method === 'UPI_GATEWAY_DYNAMIC')
      );

      if (isGatewayConfirmed) {
        gatewayConfirmedNonCashPaise += p.net_amount_paise;
      } else {
        unverifiedNonCashPaise += p.net_amount_paise;
      }
    }
  }

  const cashRefundsPaise = refundMovements.reduce((sum, rm) => sum + rm.amount_paise, 0);

  let digitalRefundsConfirmedPaise = 0;
  let digitalRefundsPendingPaise = 0;
  for (const dr of digitalRefunds) {
    if (dr.status === 'SUCCESS') {
      digitalRefundsConfirmedPaise += dr.amount_paise;
    } else if (dr.status === 'INITIATED' || dr.status === 'PENDING_GATEWAY' || dr.status === 'RETRY_SCHEDULED') {
      digitalRefundsPendingPaise += dr.amount_paise;
    }
  }

  const totalReceived = netPhysicalCashReceivedPaise + gatewayConfirmedNonCashPaise;
  const outstandingBalancePaise = Math.max(0, netPayablePaise - totalReceived);

  return {
    netPayablePaise,
    grossTenderedCashPaise,
    changeReturnedPaise,
    netPhysicalCashReceivedPaise,
    gatewayConfirmedNonCashPaise,
    unverifiedNonCashPaise,
    outstandingBalancePaise,
    cashRefundsPaise,
    digitalRefundsConfirmedPaise,
    digitalRefundsPendingPaise,
    // Aliases
    moneyTenderedPaise: grossTenderedCashPaise + gatewayConfirmedNonCashPaise + unverifiedNonCashPaise,
    moneyActuallyReceivedPaise: totalReceived,
    gatewayConfirmedMoneyPaise: gatewayConfirmedNonCashPaise,
    moneyRefundedPaise: cashRefundsPaise + digitalRefundsConfirmedPaise,
  };
}

export interface PaymentLifecycleEvaluation {
  derivedSaleStatus: SaleStatus;
  derivedPaymentStatus: SalePaymentStatus;
  totalCollectedPaise: number;
  gatewayConfirmedPaise: number;
  unverifiedClaimsPaise: number;
  remainingBalancePaise: number;
  hasUnknownOutcomes: boolean;
  hasUnverifiedClaims: boolean;
  canFinalizeAndCommit: boolean;
  errors: string[];
}

/**
 * Reconciles payment attempts and partial collections against total payable.
 * Invariants:
 * 1. Never marks a sale SETTLED until 100% of payable is collected.
 * 2. In STRICT_GATEWAY_ONLY policy, non-cash payments must be gateway-confirmed.
 * 3. Never treats an unknown outcome (TIMEOUT_UNKNOWN) as settled.
 */
export function evaluateTransactionPaymentLifecycle(
  requiredNetPayablePaise: number,
  recordedPayments: PaymentTenderAllocation[],
  policy: SettlementPolicy = 'CASHIER_ASSERTION_PERMITTED'
): PaymentLifecycleEvaluation {
  const errors: string[] = [];
  let totalCollectedPaise = 0;
  let gatewayConfirmedPaise = 0;
  let unverifiedClaimsPaise = 0;
  let hasUnknownOutcomes = false;
  let hasInFlight = false;
  let hasUnverifiedClaims = false;

  for (const p of recordedPayments) {
    if (p.outcome === 'TIMEOUT_UNKNOWN') {
      hasUnknownOutcomes = true;
      errors.push(`Payment ${p.id} outcome is TIMEOUT_UNKNOWN; requires reconciliation before settlement`);
    } else if (p.outcome === 'INITIATED' || p.outcome === 'PENDING_CONFIRMATION') {
      hasInFlight = true;
    } else if (p.outcome === 'SUCCESS') {
      totalCollectedPaise += p.net_amount_paise;
      if (p.payment_method === 'CASH') {
        gatewayConfirmedPaise += p.net_amount_paise;
      } else {
        const isConfirmed = p.is_gateway_confirmed === true || 
                            p.verification_source === 'GATEWAY_API' || 
                            (!p.verification_source && p.payment_method === 'UPI_GATEWAY_DYNAMIC');
        if (isConfirmed) {
          gatewayConfirmedPaise += p.net_amount_paise;
        } else {
          unverifiedClaimsPaise += p.net_amount_paise;
          hasUnverifiedClaims = true;
          if (policy === 'STRICT_GATEWAY_ONLY') {
            errors.push(`Payment ${p.id} (${p.payment_method}) is a cashier assertion without authoritative gateway confirmation under STRICT_GATEWAY_ONLY settlement policy`);
          }
        }
      }
    }
  }

  // Effective settled amount according to configured settlement policy
  const effectiveSettledPaise = policy === 'STRICT_GATEWAY_ONLY' ? gatewayConfirmedPaise : totalCollectedPaise;
  const remainingBalancePaise = Math.max(0, requiredNetPayablePaise - effectiveSettledPaise);

  let derivedSaleStatus: SaleStatus = 'DRAFT';
  let derivedPaymentStatus: SalePaymentStatus = 'UNSETTLED_PENDING';
  let canFinalizeAndCommit = false;

  if (recordedPayments.length === 0) {
    derivedSaleStatus = 'DRAFT';
    derivedPaymentStatus = 'UNSETTLED_PENDING';
  } else if (hasInFlight) {
    derivedSaleStatus = 'PAYMENT_IN_PROGRESS';
    derivedPaymentStatus = 'UNSETTLED_PENDING';
  } else if (effectiveSettledPaise === 0) {
    derivedSaleStatus = 'PAYMENT_IN_PROGRESS';
    derivedPaymentStatus = 'UNSETTLED_PENDING';
  } else if (effectiveSettledPaise < requiredNetPayablePaise) {
    // Partial collection (or pending gateway confirmation under strict policy)
    derivedSaleStatus = 'PARTIALLY_COLLECTED';
    derivedPaymentStatus = 'PARTIALLY_SETTLED';
  } else if (effectiveSettledPaise === requiredNetPayablePaise && !hasUnknownOutcomes) {
    // Fully settled!
    derivedSaleStatus = 'COMPLETED';
    derivedPaymentStatus = 'SETTLED';
    canFinalizeAndCommit = true;
  } else {
    // Over-collection or unknown outcome blocks completion
    derivedSaleStatus = 'PARTIALLY_COLLECTED';
    derivedPaymentStatus = 'PARTIALLY_SETTLED';
    if (effectiveSettledPaise > requiredNetPayablePaise) {
      errors.push(`Over-collection detected: Collected ${effectiveSettledPaise} exceeds payable ${requiredNetPayablePaise}`);
    }
  }

  return {
    derivedSaleStatus,
    derivedPaymentStatus,
    totalCollectedPaise,
    gatewayConfirmedPaise,
    unverifiedClaimsPaise,
    remainingBalancePaise,
    hasUnknownOutcomes,
    hasUnverifiedClaims,
    canFinalizeAndCommit,
    errors,
  };
}

export interface AbortPartialCollectionResult {
  updatedSaleStatus: 'CANCELLED_ABORTED';
  updatedPaymentStatus: SalePaymentStatus;
  updatedPayments: PaymentTenderAllocation[];
  refundCashMovement?: {
    movement_type: 'CASH_REFUND';
    amount_paise: number;
    direction: 'OUT';
    reason: string;
  };
  hasUnresolvedUnknownUPI: boolean;
}

/**
 * Aborts a partially collected transaction.
 * Invariants:
 * 1. Refunds strictly the actual physical cash received and records exactly ONE CASH_REFUND movement.
 * 2. Does NOT mark TIMEOUT_UNKNOWN payments as REFUNDED. Preserves their unresolved state for gateway reconciliation.
 */
export function abortPartialCollection(
  recordedPayments: PaymentTenderAllocation[],
  supervisorId: string,
  reason: string
): AbortPartialCollectionResult {
  const actualCashCollected = recordedPayments
    .filter(p => p.payment_method === 'CASH' && p.outcome === 'SUCCESS')
    .reduce((sum, p) => sum + p.net_amount_paise, 0);

  let refundCashMovement: AbortPartialCollectionResult['refundCashMovement'] = undefined;

  if (actualCashCollected > 0) {
    refundCashMovement = {
      movement_type: 'CASH_REFUND',
      amount_paise: actualCashCollected,
      direction: 'OUT',
      reason: `Refund partial cash upon aborted sale: ${reason} (Approved by ${supervisorId})`,
    };
  }

  let hasUnresolvedUnknownUPI = false;
  const updatedPayments = recordedPayments.map(p => {
    if (p.payment_method === 'CASH' && p.outcome === 'SUCCESS') {
      return { ...p, outcome: 'REFUNDED' as PaymentOutcome };
    }
    if (p.outcome === 'TIMEOUT_UNKNOWN') {
      hasUnresolvedUnknownUPI = true;
      // Invariant: Do NOT falsely label unresolved UPI as REFUNDED!
      return { ...p, outcome: 'TIMEOUT_UNKNOWN' as PaymentOutcome };
    }
    return p;
  });

  return {
    updatedSaleStatus: 'CANCELLED_ABORTED',
    updatedPaymentStatus: hasUnresolvedUnknownUPI ? 'UNSETTLED_PENDING' : 'REFUNDED',
    updatedPayments,
    refundCashMovement,
    hasUnresolvedUnknownUPI,
  };
}

/**
 * Initiates an authoritative, durable digital refund record.
 * Invariant: Never treats refund initiation as proof that the customer received the money.
 */
export function initiateDigitalRefund(params: {
  paymentId: string;
  saleId: string;
  amountPaise: number;
  customerVpa?: string;
  existingRefunds?: DigitalRefundRecord[];
  idempotencyKey?: string;
}): DigitalRefundRecord {
  const idempotency_key = params.idempotencyKey ?? `idemp_${params.saleId}_${params.paymentId}`;

  // Idempotency: If a refund for this payment or with this idempotency key already exists, return it without creating duplicate
  if (params.existingRefunds) {
    const existing = params.existingRefunds.find(
      r => r.payment_id === params.paymentId || (r.idempotency_key && r.idempotency_key === idempotency_key)
    );
    if (existing) {
      return existing;
    }
  }

  return {
    id: `ref_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    idempotency_key,
    payment_id: params.paymentId,
    sale_id: params.saleId,
    customer_vpa: params.customerVpa,
    amount_paise: params.amountPaise,
    status: 'INITIATED',
    retry_count: 0,
    initiated_at: new Date().toISOString(),
  };
}

/**
 * Updates digital refund lifecycle state based on gateway webhook or status inquiry.
 * Handles idempotency: duplicate webhook calls for SUCCESS/FAILED are safe no-ops.
 */
export function updateDigitalRefundStatus(
  refund: DigitalRefundRecord,
  gatewayEvent: {
    status: 'SUCCESS' | 'FAILED';
    gatewayReference?: string;
    failureReason?: string;
  }
): DigitalRefundRecord {
  // Idempotency check: If already completed with SUCCESS, ignore repeated events
  if (refund.status === 'SUCCESS') {
    return refund;
  }

  if (gatewayEvent.status === 'SUCCESS') {
    return {
      ...refund,
      status: 'SUCCESS',
      gateway_reference: gatewayEvent.gatewayReference ?? refund.gateway_reference,
      completed_at: new Date().toISOString(),
    };
  }

  // FAILED
  return {
    ...refund,
    status: 'FAILED',
    failure_reason: gatewayEvent.failureReason ?? 'Gateway rejected digital refund',
    retry_count: refund.retry_count + 1,
  };
}

export interface ReconcileUnknownPaymentResult {
  updatedPayment: PaymentTenderAllocation;
  requiresDigitalRefund: boolean;
  digitalRefundRecord?: DigitalRefundRecord;
  actionTaken: string;
}

/**
 * Idempotently reconciles an unknown payment against bank gateway status.
 * Invariant: SQLite write transactions are never held open while waiting for external payment gateway.
 */
export function reconcileUnknownPayment(
  payment: PaymentTenderAllocation,
  gatewayStatus: 'SUCCESS' | 'FAILED',
  wasSaleAborted: boolean,
  customerVpa?: string,
  saleId: string = 'unknown_sale'
): ReconcileUnknownPaymentResult {
  // Idempotency: If already resolved, return as-is
  if (payment.outcome !== 'TIMEOUT_UNKNOWN') {
    return {
      updatedPayment: payment,
      requiresDigitalRefund: false,
      actionTaken: `Payment was already resolved with outcome '${payment.outcome}'. Idempotent no-op.`,
    };
  }

  if (gatewayStatus === 'FAILED') {
    return {
      updatedPayment: {
        ...payment,
        outcome: 'FAILED',
        reconciled_disposition: 'GATEWAY_CONFIRMED_FAILED',
      },
      requiresDigitalRefund: false,
      actionTaken: 'Gateway confirmed payment failed. No funds debited.',
    };
  }

  // Gateway confirmed SUCCESS!
  if (wasSaleAborted) {
    // Crucial rule: Customer was debited for an aborted sale!
    // Triggers automatic digital refund to source account (NEVER cash drawer outflow)
    const digitalRefundRecord = initiateDigitalRefund({
      paymentId: payment.id,
      saleId,
      amountPaise: payment.net_amount_paise,
      customerVpa,
    });

    return {
      updatedPayment: {
        ...payment,
        outcome: 'SUCCESS',
        reconciled_disposition: 'UNSOLICITED_GATEWAY_SUCCESS_AUTO_REFUND',
        digital_refund_id: digitalRefundRecord.id,
      },
      requiresDigitalRefund: true,
      digitalRefundRecord,
      actionTaken: 'Gateway confirmed funds debited for aborted sale. Digital reversal to source VPA initiated.',
    };
  }

  return {
    updatedPayment: {
      ...payment,
      outcome: 'SUCCESS',
      reconciled_disposition: 'RECONCILED_SUCCESS',
    },
    requiresDigitalRefund: false,
    actionTaken: 'Gateway confirmed success. Payment settled towards sale.',
  };
}

export interface ExpiredReservationPaymentResolution {
  resolution: 'RE_RESERVED_AND_FULFILLABLE' | 'STOCK_EXHAUSTED_REFUND_REQUIRED';
  payment: PaymentTenderAllocation;
  digitalRefundRecord?: DigitalRefundRecord;
  refundRecord?: DigitalRefundRecord;
  message: string;
}

/**
 * Resolves a scenario where UPI/gateway payment succeeds after the stock reservation expired.
 * Invariant: Preserves the payment record durably and never silently drops captured money.
 */
export function handlePaymentSuccessWithExpiredReservation(params: {
  payment: PaymentTenderAllocation;
  saleId: string;
  requiredQuantity: number;
  availableStock: number;
  customerVpa?: string;
}): ExpiredReservationPaymentResolution {
  // Always mark payment as SUCCESS — the money is in the merchant account!
  const confirmedPayment: PaymentTenderAllocation = {
    ...params.payment,
    outcome: 'SUCCESS',
  };

  if (params.availableStock >= params.requiredQuantity) {
    // Stock is still physically available on shelf: can proceed to re-reserve and complete fulfillment
    return {
      resolution: 'RE_RESERVED_AND_FULFILLABLE',
      payment: {
        ...confirmedPayment,
        reconciled_disposition: 'LATE_PAYMENT_ACCEPTED_STOCK_RE_RESERVED',
      },
      message: 'Payment received after reservation TTL; inventory still available. Re-reserved and ready for fulfillment.',
    };
  }

  // Stock was sold out while waiting for customer payment!
  // Must preserve payment in ledger and initiate automated digital refund to avoid silent theft
  const refundRecord = initiateDigitalRefund({
    paymentId: confirmedPayment.id,
    saleId: params.saleId,
    amountPaise: confirmedPayment.net_amount_paise,
    customerVpa: params.customerVpa,
  });

  return {
    resolution: 'STOCK_EXHAUSTED_REFUND_REQUIRED',
    payment: {
      ...confirmedPayment,
      reconciled_disposition: 'LATE_PAYMENT_OUT_OF_STOCK_REFUND_INITIATED',
      digital_refund_id: refundRecord.id,
    },
    digitalRefundRecord: refundRecord,
    refundRecord,
    message: 'Payment captured after reservation TTL but item stock is exhausted. Digital refund initiated to customer.',
  };
}
