import { 
  CanonicalSaleAggregate, 
  CashMovementType, 
  StockMovementType, 
  InventoryUnit 
} from '@malgudi/contracts';

export type ReturnDisposition = 'RESTOCK_SELLABLE' | 'DAMAGED_SCRAP' | 'REJECTED_NO_RETURN';
export type RefundMethod = 'CASH' | 'ORIGINAL_PAYMENT_METHOD' | 'STORE_CREDIT';

export interface ProcessReversalParams {
  originalAggregate: CanonicalSaleAggregate;
  reversalReason: string;
  supervisorId: string;
  refundMethod?: RefundMethod;
  itemReturns?: Array<{
    item_id: string;
    quantity_to_return: number;
    disposition: ReturnDisposition;
  }>;
  cashRefundAmountPaise?: number;
}

export interface ReversalExecutionPlan {
  reversalId: string;
  reversalType: 'VOID_UNPAID' | 'CANCEL_PARTIAL' | 'REFUND_COMPLETED' | 'ITEM_RETURN';
  isFullVoid: boolean;
  refundMethod: RefundMethod;
  cashMovementsToExecute: Array<{
    movement_type: CashMovementType;
    amount_paise: number;
    direction: 'OUT';
    reason: string;
  }>;
  stockMovementsToExecute: Array<{
    product_id: string;
    movement_type: StockMovementType;
    quantity_delta: number;
    unit: InventoryUnit;
    reason: string;
  }>;
  updatedSaleStatus: 'VOIDED' | 'RETURNED_PARTIAL' | 'RETURNED_FULL';
  updatedPaymentStatus: 'REFUNDED' | 'SETTLED' | 'PARTIALLY_SETTLED';
}

export function planReversal(params: ProcessReversalParams): ReversalExecutionPlan {
  const { originalAggregate, reversalReason, supervisorId, itemReturns, cashRefundAmountPaise } = params;
  const originalSale = originalAggregate.sale;

  // Idempotency: Protect against double-reversal
  if (originalSale.sale_status === 'VOIDED' || originalSale.sale_status === 'RETURNED_FULL') {
    throw new Error(`Sale ${originalSale.id} is already reversed with status '${originalSale.sale_status}'. Duplicate reversal rejected.`);
  }

  const reversalId = `rev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Determine prior actual cash collected
  const priorCashReceived = originalAggregate.payments
    .filter(p => p.payment_method === 'CASH' && p.outcome === 'SUCCESS')
    .reduce((sum, p) => sum + p.net_amount_paise, 0);

  const priorNonCashReceived = originalAggregate.payments
    .filter(p => p.payment_method !== 'CASH' && p.outcome === 'SUCCESS')
    .reduce((sum, p) => sum + p.net_amount_paise, 0);

  // Default refund method based on original payment
  const refundMethod: RefundMethod = params.refundMethod ?? (priorCashReceived > 0 ? 'CASH' : 'ORIGINAL_PAYMENT_METHOD');

  // Case 1: Voiding an unpaid or aborted sale
  if (originalSale.payment_status === 'PAYMENT_FAILED' || originalSale.payment_status === 'UNSETTLED_PENDING') {
    const cashMovements: ReversalExecutionPlan['cashMovementsToExecute'] = [];

    // If partial cash was actually received before cancellation, refund strictly that exact received cash
    if (priorCashReceived > 0 && refundMethod === 'CASH') {
      cashMovements.push({
        movement_type: 'CASH_REFUND',
        amount_paise: priorCashReceived,
        direction: 'OUT',
        reason: `Refund partial cash received on cancelled bill: ${reversalReason} (Approved by ${supervisorId})`,
      });
    }

    // Restore tentatively deducted stock only for items that actually had stock movements
    const stockMovements = originalAggregate.stock_movements
      .filter(sm => sm.quantity_delta < 0)
      .map(sm => ({
        product_id: sm.product_id,
        movement_type: 'VOID_STOCK_REVERSAL' as StockMovementType,
        quantity_delta: Math.abs(sm.quantity_delta),
        unit: sm.unit,
        reason: `Void unpaid bill: ${reversalReason}`,
      }));

    const reversalType = priorCashReceived > 0 || priorNonCashReceived > 0 ? 'CANCEL_PARTIAL' : 'VOID_UNPAID';

    return {
      reversalId,
      reversalType,
      isFullVoid: true,
      refundMethod,
      cashMovementsToExecute: cashMovements,
      stockMovementsToExecute: stockMovements,
      updatedSaleStatus: 'VOIDED',
      updatedPaymentStatus: 'REFUNDED',
    };
  }

  // Case 2: Completed Sale Reversal (Full refund or Item-Level return)
  const cashMovements: ReversalExecutionPlan['cashMovementsToExecute'] = [];
  const stockMovements: ReversalExecutionPlan['stockMovementsToExecute'] = [];

  // Calculate refund amount
  const refundAmount = cashRefundAmountPaise ?? originalSale.net_payable_paise;

  // Invariant: Do NOT automatically create cash drawer outflow for non-cash sales
  if (refundAmount > 0 && refundMethod === 'CASH') {
    cashMovements.push({
      movement_type: 'CASH_REFUND',
      amount_paise: refundAmount,
      direction: 'OUT',
      reason: `Customer cash refund: ${reversalReason} (Approved by ${supervisorId})`,
    });
  }

  // Determine inventory disposition with strict validation against prior deduction
  if (itemReturns && itemReturns.length > 0) {
    for (const ret of itemReturns) {
      const origItem = originalAggregate.items.find(i => i.id === ret.item_id);
      if (!origItem) {
        throw new Error(`Item ${ret.item_id} not found in original sale aggregate.`);
      }

      const priorDeduction = Math.abs(origItem.stock_deduction_delta);
      const previouslyRestocked = origItem.cumulative_restocked_quantity ?? 0;
      const availableToReverse = priorDeduction - previouslyRestocked;

      if (ret.disposition === 'RESTOCK_SELLABLE') {
        if (priorDeduction === 0) {
          throw new Error(`Cannot restock non-inventory item ${origItem.product_id} with zero prior stock deduction.`);
        }
        if (ret.quantity_to_return > availableToReverse) {
          throw new Error(`Cumulative return quantity (${previouslyRestocked + ret.quantity_to_return}) exceeds prior deduction (${priorDeduction}).`);
        }

        stockMovements.push({
          product_id: origItem.product_id,
          movement_type: 'CUSTOMER_RETURN_RESTOCK',
          quantity_delta: Math.abs(ret.quantity_to_return),
          unit: origItem.stock_unit,
          reason: `Restocked customer return: ${reversalReason}`,
        });
      } else if (ret.disposition === 'DAMAGED_SCRAP') {
        // Recorded as damage/wastage, not added back to sellable shelf inventory
        stockMovements.push({
          product_id: origItem.product_id,
          movement_type: 'WASTAGE_DAMAGE',
          quantity_delta: -Math.abs(ret.quantity_to_return),
          unit: origItem.stock_unit,
          reason: `Damaged customer return scrapped: ${reversalReason}`,
        });
      }
      // 'REJECTED_NO_RETURN': creates 0 stock movements
    }
  }

  const isFull = refundAmount >= originalSale.net_payable_paise;
  return {
    reversalId,
    reversalType: isFull ? 'REFUND_COMPLETED' : 'ITEM_RETURN',
    isFullVoid: isFull,
    refundMethod,
    cashMovementsToExecute: cashMovements,
    stockMovementsToExecute: stockMovements,
    updatedSaleStatus: isFull ? 'RETURNED_FULL' : 'RETURNED_PARTIAL',
    updatedPaymentStatus: isFull ? 'REFUNDED' : 'PARTIALLY_SETTLED',
  };
}
