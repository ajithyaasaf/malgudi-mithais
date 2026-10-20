// Malgudi Mithais Contracts & Domain Types (v2.9)

export type PricingUnit = 'PER_KG' | 'PER_PIECE' | 'PER_PACK' | 'PER_BOX' | 'PER_DOZEN';
export type InventoryUnit = 'MG' | 'PIECE' | 'PACK' | 'BOX';
export type PricingBasis = 'TAX_INCLUSIVE' | 'TAX_EXCLUSIVE';

export type PaymentMethod = 
  | 'CASH' 
  | 'UPI'
  | 'UPI_MANUAL_RECORDED' 
  | 'UPI_GATEWAY_DYNAMIC' 
  | 'CARD_EXTERNAL';

export type PaymentOutcome = 
  | 'INITIATED'
  | 'SUCCESS' 
  | 'PENDING_CONFIRMATION' 
  | 'TIMEOUT_UNKNOWN' 
  | 'FAILED' 
  | 'REFUNDED';

export type SalePaymentStatus = 
  | 'UNSETTLED_PENDING' 
  | 'PARTIALLY_SETTLED' 
  | 'SETTLED' 
  | 'PAYMENT_FAILED'
  | 'REFUNDED';

export type SaleStatus = 
  | 'DRAFT'
  | 'HELD'
  | 'PAYMENT_IN_PROGRESS'
  | 'PARTIALLY_COLLECTED'
  | 'COMPLETED' 
  | 'VOIDED' 
  | 'RETURNED_PARTIAL' 
  | 'RETURNED_FULL' 
  | 'CANCELLED_ABORTED';

export type SyncStatus = 
  | 'LOCAL_DURABLE' 
  | 'SYNC_PENDING' 
  | 'SERVER_ACKNOWLEDGED' 
  | 'SYNC_CONFLICT';

export type StockMovementType = 
  | 'OPENING_STOCK' 
  | 'RECEIPT_PRODUCTION' 
  | 'RECEIPT_SUPPLIER' 
  | 'TRANSFER_IN' 
  | 'TRANSFER_OUT' 
  | 'SALE_DEDUCTION' 
  | 'CUSTOMER_RETURN_RESTOCK' 
  | 'WASTAGE_DAMAGE' 
  | 'WASTAGE_EXPIRED' 
  | 'RECONCILIATION_ADJUSTMENT' 
  | 'VOID_STOCK_REVERSAL';

export type CashMovementType = 
  | 'OPENING_FLOAT' 
  | 'CASH_SALE' 
  | 'CASH_REFUND' 
  | 'DRAWER_EXPENSE' 
  | 'CASH_DROP' 
  | 'CASH_ADDITION' 
  | 'CASH_COLLECTION' 
  | 'VOID_REVERSAL' 
  | 'AUTHORIZED_CORRECTION';

export type WeightInputSource = 'SCALE_AUTO' | 'MANUAL_KEYPAD';

export type TerminalStatus = 'PROVISIONED' | 'ACTIVE' | 'RETIRED_LOCKED' | 'DECOMMISSIONED';

export type StockReservationStatus = 'ACTIVE' | 'COMMITTED' | 'EXPIRED' | 'RELEASED';

export interface StockReservation {
  id: string;
  cart_or_sale_id: string;
  branch_id: string;
  product_id: string;
  reserved_quantity: number;
  unit: InventoryUnit;
  status: StockReservationStatus;
  expires_at: string;
  created_at: string;
}

export interface TerminalLease {
  lease_version: '2.9';
  terminal_id: string;
  series_code: string;
  key_id: string;
  lease_start_epoch_ms: number;
  lease_valid_until_epoch_ms: number;
  max_offline_hours: number;
  signature_hex: string;
}

export interface TrustBundle {
  bundle_version: number;
  active_keys: Array<{ key_id: string; public_key_pem: string }>;
  revoked_key_ids: string[];
  issued_at: string;
  signature_hex: string;
}

export interface ProductDefinition {
  id: string;
  name: string;
  tamil_name: string;
  sku: string;
  barcode?: string;
  category_id: string;
  pricing_unit: PricingUnit;
  inventory_unit: InventoryUnit;
  pricing_basis: PricingBasis;
  base_price_paise: number;
  piece_price_paise?: number; // Optional independent piece price for per-dozen items
  tax_rate_bps: number; // e.g. 500 = 5.00%, 1800 = 18.00%
  hsn_code: string;
  is_active: boolean;
}

export interface SaleItemAllocation {
  id: string;
  product_id: string;
  quantity_input: number; // mg for weight, count for units/dozens
  pricing_unit: PricingUnit;
  weight_input_source: WeightInputSource;
  unit_price_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_tax_paise: number;
  gross_paise: number;
  stock_deduction_delta: number; // Signed delta in canonical unit (e.g. -375000)
  stock_unit: InventoryUnit;
  cumulative_restocked_quantity?: number; // Tracks previous returns to prevent over-reversals
  reservation_id?: string; // Links line item to active stock reservation
}

export type DigitalRefundStatus = 
  | 'INITIATED' 
  | 'PENDING_GATEWAY' 
  | 'SUCCESS' 
  | 'FAILED' 
  | 'RETRY_SCHEDULED';

export type PaymentVerificationSource =
  | 'GATEWAY_API'
  | 'SOUNDBOX_BROADCAST'
  | 'CASHIER_UNVERIFIED_CLAIM'
  | 'PHYSICAL_CASH_DRAWER';

export type SettlementPolicy = 
  | 'STRICT_GATEWAY_ONLY'
  | 'CASHIER_ASSERTION_PERMITTED';

export interface DigitalRefundRecord {
  id: string; // Unique refund identifier
  idempotency_key?: string; // Stable idempotency identifier for payment gateway
  payment_id: string; // References original PaymentTenderAllocation.id
  sale_id: string;
  customer_vpa?: string;
  amount_paise: number;
  status: DigitalRefundStatus;
  gateway_reference?: string;
  failure_reason?: string;
  retry_count: number;
  initiated_at: string;
  completed_at?: string;
}

export interface PaymentTenderAllocation {
  id: string;
  payment_method: PaymentMethod;
  allocated_amount_paise: number; // Portion of bill settled by this tender
  tendered_paise: number;         // Amount handed over (e.g. ₹500 note)
  change_returned_paise: number;  // Change returned (e.g. ₹245)
  net_amount_paise: number;       // Must equal allocated_amount_paise (e.g. ₹255)
  outcome: PaymentOutcome;
  verification_source?: PaymentVerificationSource;
  is_gateway_confirmed?: boolean;
  reference_note?: string;
  verified_by_user_id?: string;
  reconciled_disposition?: string; // E.g. 'UNSOLICITED_GATEWAY_SUCCESS_AUTO_REFUND'
  digital_refund_id?: string;     // References DigitalRefundRecord if digital refund initiated
}

export interface CanonicalSaleAggregate {
  version: '2.9';
  sale: {
    id: string; // Root UUIDv7
    invoice_number: string;
    branch_id: string;
    counter_id: string;
    terminal_id: string;
    session_id: string;
    business_date: string;
    tax_policy_version: string;
    subtotal_taxable_paise: number;
    total_cgst_paise: number;
    total_sgst_paise: number;
    total_igst_paise: number;
    round_off_paise: number;
    net_payable_paise: number;
    sale_status: SaleStatus;
    payment_status: SalePaymentStatus;
    sync_status: SyncStatus;
    created_at: string;
    manual_invoice_reference?: string; // Contingency link if manual bill book used
  };
  items: SaleItemAllocation[];
  payments: PaymentTenderAllocation[];
  cash_movements: Array<{
    id: string;
    session_id: string;
    branch_id: string;
    movement_type: CashMovementType;
    amount_paise: number; // Always positive integer
    direction: 'IN' | 'OUT';
    reference_id: string; // Points to sale.id
    created_at: string;
  }>;
  stock_movements: Array<{
    id: string;
    branch_id: string;
    product_id: string;
    movement_type: StockMovementType;
    quantity_delta: number; // Signed integer
    unit: InventoryUnit;
    reference_id: string; // Points to sale.id
    created_at: string;
  }>;
  outbox: {
    event_id: string;
    aggregate_type: 'SALE';
    aggregate_id: string; // Equals sale.id
    event_seq: number;
    payload_hash: string;
    created_at: string;
  };
  audit: {
    id: string;
    action: string;
    entity_type: 'SALE';
    entity_id: string;
    actor_id: string;
    created_at: string;
  };
}
