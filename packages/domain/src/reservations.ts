import { 
  StockReservation, 
  StockReservationStatus, 
  InventoryUnit, 
  StockMovementType 
} from '@malgudi/contracts';

export type ReservationScope = 'TERMINAL_LOCAL' | 'BRANCH_LAN';

export interface ReservationScopePolicy {
  scope: ReservationScope;
  canCoordinateCrossTerminal: boolean;
  disconnectionLimitation: string;
}

/**
 * Returns reservation coordination capabilities based on LAN connectivity.
 * Invariant: Air-gapped terminals cannot coordinate reservations in real-time.
 */
export function getReservationScopePolicy(isLanOnline: boolean): ReservationScopePolicy {
  return {
    scope: isLanOnline ? 'BRANCH_LAN' : 'TERMINAL_LOCAL',
    canCoordinateCrossTerminal: isLanOnline,
    disconnectionLimitation: 'Air-gapped offline terminals cannot prevent concurrent inventory over-selling across separate counters; physical safeguards (tray stock) govern retail counter operations.',
  };
}

export interface CreateReservationParams {
  cartOrSaleId: string;
  branchId: string;
  productId: string;
  quantity: number;
  unit: InventoryUnit;
  ttlSeconds?: number;
}

export function createStockReservation(params: CreateReservationParams): StockReservation {
  const now = Date.now();
  const ttl = (params.ttlSeconds ?? 900) * 1000; // Default 15 minutes TTL

  return {
    id: `res_${now}_${Math.random().toString(36).substring(2, 8)}`,
    cart_or_sale_id: params.cartOrSaleId,
    branch_id: params.branchId,
    product_id: params.productId,
    reserved_quantity: Math.abs(params.quantity),
    unit: params.unit,
    status: 'ACTIVE',
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl).toISOString(),
  };
}

/**
 * Available Stock Calculation:
 * Available = Physical On-Hand - Sum of Active (Non-Expired) Reservations
 */
export function calculateAvailableStock(
  onHandStock: number,
  reservations: StockReservation[],
  productId: string,
  currentTimestampMs: number = Date.now()
): number {
  const activeReserved = reservations
    .filter(r => 
      r.product_id === productId && 
      r.status === 'ACTIVE' && 
      new Date(r.expires_at).getTime() > currentTimestampMs
    )
    .reduce((sum, r) => sum + r.reserved_quantity, 0);

  return onHandStock - activeReserved;
}

/**
 * Commits active reservations upon successful sale finalization.
 * Concurrency guard: Rejects committing reservations that have already expired or are non-ACTIVE.
 */
export function commitReservations(
  reservations: StockReservation[],
  saleId: string,
  currentTimestampMs: number = Date.now()
): {
  updatedReservations: StockReservation[];
  stockMovements: Array<{
    id: string;
    branch_id: string;
    product_id: string;
    movement_type: StockMovementType;
    quantity_delta: number;
    unit: InventoryUnit;
    reference_id: string;
    created_at: string;
  }>;
} {
  const nowIso = new Date(currentTimestampMs).toISOString();
  const updatedReservations: StockReservation[] = [];
  const stockMovements: any[] = [];

  for (const r of reservations) {
    if (r.status !== 'ACTIVE') {
      throw new Error(`Cannot commit reservation ${r.id} with status '${r.status}'`);
    }

    if (new Date(r.expires_at).getTime() <= currentTimestampMs) {
      throw new Error(`Cannot commit reservation ${r.id}: Reservation expired at ${r.expires_at} before checkout committed.`);
    }

    updatedReservations.push({
      ...r,
      status: 'COMMITTED',
    });

    stockMovements.push({
      id: `sm_${r.id}`,
      branch_id: r.branch_id,
      product_id: r.product_id,
      movement_type: 'SALE_DEDUCTION',
      quantity_delta: -r.reserved_quantity, // Negative outflow
      unit: r.unit,
      reference_id: saleId,
      created_at: nowIso,
    });
  }

  return { updatedReservations, stockMovements };
}

/**
 * Releases active reservations when a cart is cleared or sale is aborted/voided.
 */
export function releaseReservations(reservations: StockReservation[]): StockReservation[] {
  return reservations.map(r => {
    if (r.status === 'COMMITTED') {
      throw new Error(`Cannot release committed reservation ${r.id}; requires formal stock reversal movement.`);
    }
    return {
      ...r,
      status: 'RELEASED' as StockReservationStatus,
    };
  });
}

/**
 * Periodic background task: expires reservations whose TTL has lapsed.
 * Concurrency guard: Only transitions ACTIVE reservations; never mutates COMMITTED or RELEASED.
 */
export function expireStaleReservations(
  reservations: StockReservation[],
  currentTimestampMs: number = Date.now()
): StockReservation[] {
  return reservations.map(r => {
    if (r.status === 'ACTIVE' && new Date(r.expires_at).getTime() <= currentTimestampMs) {
      return {
        ...r,
        status: 'EXPIRED' as StockReservationStatus,
      };
    }
    return r;
  });
}

/**
 * Atomic reservation commit function with concurrency guard and idempotency.
 * Invariant:
 * 1. Rejects committing if already expired or released.
 * 2. Prevents double deductions on repeated finalization calls.
 */
export function atomicCommitReservation(
  reservation: StockReservation,
  saleId: string,
  currentTimestampMs: number = Date.now()
): {
  updatedReservation: StockReservation;
  stockMovement: {
    id: string;
    branch_id: string;
    product_id: string;
    movement_type: StockMovementType;
    quantity_delta: number;
    unit: InventoryUnit;
    reference_id: string;
    created_at: string;
  };
  isAlreadyCommitted: boolean;
} {
  if (reservation.status === 'COMMITTED') {
    // Idempotent safeguard: already committed; do NOT duplicate stock deduction
    return {
      updatedReservation: reservation,
      stockMovement: {
        id: `sm_${reservation.id}`,
        branch_id: reservation.branch_id,
        product_id: reservation.product_id,
        movement_type: 'SALE_DEDUCTION',
        quantity_delta: -reservation.reserved_quantity,
        unit: reservation.unit,
        reference_id: saleId,
        created_at: reservation.created_at,
      },
      isAlreadyCommitted: true,
    };
  }

  if (reservation.status !== 'ACTIVE') {
    throw new Error(`Cannot commit reservation ${reservation.id}: current status is '${reservation.status}' (must be 'ACTIVE').`);
  }

  if (new Date(reservation.expires_at).getTime() <= currentTimestampMs) {
    throw new Error(`Cannot commit reservation ${reservation.id}: Reservation expired at ${reservation.expires_at} before checkout committed.`);
  }

  const nowIso = new Date(currentTimestampMs).toISOString();
  return {
    updatedReservation: {
      ...reservation,
      status: 'COMMITTED',
    },
    stockMovement: {
      id: `sm_${reservation.id}`,
      branch_id: reservation.branch_id,
      product_id: reservation.product_id,
      movement_type: 'SALE_DEDUCTION',
      quantity_delta: -reservation.reserved_quantity,
      unit: reservation.unit,
      reference_id: saleId,
      created_at: nowIso,
    },
    isAlreadyCommitted: false,
  };
}

/**
 * Recovers reservation state after application crash or restart.
 * Invariant: Identifies active reservations, expires those whose TTL lapsed during downtime,
 * and restores unexpired active reservations to in-memory tracking.
 */
export function recoverReservationsAfterRestart(
  persistedReservations: StockReservation[],
  restartTimestampMs: number = Date.now()
): {
  activeReservations: StockReservation[];
  expiredReservations: StockReservation[];
  allRecovered: StockReservation[];
} {
  const activeReservations: StockReservation[] = [];
  const expiredReservations: StockReservation[] = [];
  const allRecovered: StockReservation[] = [];

  for (const r of persistedReservations) {
    if (r.status === 'ACTIVE') {
      if (new Date(r.expires_at).getTime() <= restartTimestampMs) {
        const expired = { ...r, status: 'EXPIRED' as StockReservationStatus };
        expiredReservations.push(expired);
        allRecovered.push(expired);
      } else {
        activeReservations.push(r);
        allRecovered.push(r);
      }
    } else {
      allRecovered.push(r);
    }
  }

  return {
    activeReservations,
    expiredReservations,
    allRecovered,
  };
}

/**
 * Strict Reversal Invariant:
 * Asserts that any positive stock restoration references a genuine prior reservation or deduction,
 * and cumulative returns do not exceed original unreversed quantity.
 */
export function validateStockReversalJustification(
  priorDeductionDelta: number,
  attemptedRestoreQuantity: number,
  cumulativeAlreadyRestocked: number = 0
): boolean {
  if (priorDeductionDelta >= 0) {
    throw new Error('Reversal rejected: No prior negative stock deduction found for this item.');
  }
  const maxRestorable = Math.abs(priorDeductionDelta);
  const remainingAvailable = maxRestorable - cumulativeAlreadyRestocked;

  if (attemptedRestoreQuantity <= 0) {
    throw new Error('Reversal rejected: Restore quantity must be strictly positive.');
  }
  if (attemptedRestoreQuantity > remainingAvailable) {
    throw new Error(`Reversal rejected: Attempted restore quantity (${attemptedRestoreQuantity}) exceeds unreversed quantity (${remainingAvailable}) of original sale (${maxRestorable}).`);
  }
  return true;
}
