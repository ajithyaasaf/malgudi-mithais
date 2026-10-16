import React, { useState, useEffect, useMemo, useRef } from 'react';
import { check as checkTauriUpdate, Update as TauriUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { calculateLineItem } from '@malgudi/domain/pricing.js';
import { validateAndReconcileSplitTender, evaluateTransactionPaymentLifecycle } from '@malgudi/domain/tender.js';
import { getIndianFinancialYearCode } from '@malgudi/domain/aggregate.js';
import {
  PaymentTenderAllocation,
  ProductDefinition,
  SaleItemAllocation,
  PaymentVerificationSource,
  SettlementPolicy,
  WeightInputSource,
  PricingUnit,
  InventoryUnit,
  PricingBasis,
} from '@malgudi/contracts';

declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
  }
}

export interface FinalizeSaleResult {
  sale_id: string;
  invoice_number: string;
  event_id: string;
  payload_hash: string;
  items_count: number;
  net_payable_paise: number;
  cash_retained_paise: number;
  upi_settled_paise: number;
  sale_status?: string;
  payment_status: string;
  created_at: string;
}

export interface DetailedReceiptItem {
  product_id: string;
  product_name: string;
  tamil_name: string;
  pricing_unit: string;
  quantity_input: number;
  quantity_formatted: string;
  unit_price_paise: number;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  total_tax_paise: number;
  gross_paise: number;
}

export interface DetailedReceiptPayment {
  payment_method: string;
  allocated_amount_paise: number;
  tendered_paise: number;
  change_returned_paise: number;
  net_amount_paise: number;
}

export interface DetailedSaleReceipt {
  sale_id: string;
  invoice_number: string;
  business_date: string;
  created_at: string;
  cashier_name: string;
  terminal_id: string;
  branch_id: string;
  branch_name: string;
  subtotal_taxable_paise: number;
  total_cgst_paise: number;
  total_sgst_paise: number;
  round_off_paise: number;
  net_payable_paise: number;
  sale_status: string;
  payment_status: string;
  items: DetailedReceiptItem[];
  payments: DetailedReceiptPayment[];
  items_count?: number;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_location?: string | null;
}

export interface OpeningFloatStatus {
  has_opening_float: boolean;
  opening_float_paise: number;
  session_id: string;
  business_date: string;
  recorded_at?: string | null;
  is_day_closed: boolean;
}

export interface LiveCashDrawerSummary {
  has_opening_float: boolean;
  opening_float_paise: number;
  cash_sales_paise: number;
  cash_refunds_paise: number;
  current_drawer_cash_paise: number;
  is_day_closed: boolean;
  business_date: string;
  branch_id: string;
  recorded_at?: string | null;
}

export interface DayEndSummary {
  business_date: string;
  branch_name: string;
  terminal_id: string;
  session_id: string;
  closed_by_user: string;
  closed_at: string;
  opening_float_paise: number;
  cash_sales_paise: number;
  cash_refunds_paise: number;
  expected_closing_cash_paise: number;
  counted_closing_cash_paise: number;
  variance_paise: number;
  variance_notes?: string | null;
  total_bills_recorded: number;
  active_bills_count: number;
  voided_bills_count: number;
  gross_sales_paise: number;
  net_sales_paise: number;
  cash_realized_paise: number;
  upi_realized_paise: number;
  total_taxable_paise: number;
  total_cgst_paise: number;
  total_sgst_paise: number;
  total_tax_paise: number;
  pending_sync_count: number;
}

export interface DBProductRecord {
  id: string;
  name: string;
  tamil_name: string;
  sku: string;
  barcode?: string | null;
  category_id: string;
  pricing_unit: PricingUnit;
  inventory_unit: InventoryUnit;
  pricing_basis: PricingBasis;
  base_price_paise: number;
  piece_price_paise?: number | null;
  tax_rate_bps: number;
  hsn_code: string;
  is_active: boolean;
  version?: number;
  current_stock: number;
  stock_unit: string;
  created_at: string;
  updated_at: string;
}

export function toProductDefinition(rec: DBProductRecord): ProductDefinition {
  return {
    id: rec.id,
    name: rec.name,
    tamil_name: rec.tamil_name,
    sku: rec.sku,
    barcode: rec.barcode ?? undefined,
    category_id: rec.category_id,
    pricing_unit: rec.pricing_unit,
    inventory_unit: rec.inventory_unit,
    pricing_basis: rec.pricing_basis,
    base_price_paise: rec.base_price_paise,
    piece_price_paise: rec.piece_price_paise ?? undefined,
    tax_rate_bps: rec.tax_rate_bps,
    hsn_code: rec.hsn_code,
    is_active: rec.is_active,
  };
}

export function formatDateTime(dateStr: string | number | undefined | null): string {
  if (!dateStr) return '-';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return String(dateStr);
  }
}

export interface StockMovementRecord {
  id: string;
  branch_id: string;
  product_id: string;
  movement_type: string;
  quantity_delta: number;
  unit: string;
  reference_id: string;
  reason?: string | null;
  actor_id?: string | null;
  created_at: string;
}

export interface DailySalesSummary {
  total_bills_recorded: number;
  active_bills_count: number;
  voided_bills_count: number;
  gross_sales_paise: number;
  taxable_sales_paise: number;
  total_cgst_paise: number;
  total_sgst_paise: number;
  total_igst_paise: number;
  total_tax_paise: number;
  round_off_paise: number;
  voided_amount_paise: number;
  net_sales_paise: number;
  daily_breakdown: {
    business_date: string;
    total_bills: number;
    active_bills: number;
    voided_bills: number;
    taxable_sales_paise: number;
    total_tax_paise: number;
    gross_sales_paise: number;
    voided_amount_paise: number;
    net_sales_paise: number;
  }[];
}

export interface PaymentSummaryReport {
  total_cash_collected_paise: number;
  total_cash_tendered_paise: number;
  total_change_returned_paise: number;
  total_upi_collected_paise: number;
  total_split_bills_count: number;
  total_split_amount_paise: number;
  cash_refunds_paise: number;
  upi_refunds_paise: number;
  net_cash_paise: number;
  net_upi_paise: number;
  total_net_collected_paise: number;
  methods_breakdown: {
    payment_method: string;
    bills_count: number;
    total_collected_paise: number;
    refunds_paise: number;
    net_amount_paise: number;
  }[];
}

export interface GstReport {
  total_taxable_paise: number;
  total_cgst_paise: number;
  total_sgst_paise: number;
  total_igst_paise: number;
  total_gst_paise: number;
  total_invoice_value_paise: number;
  slabs_breakdown: {
    tax_rate_percent: number;
    taxable_paise: number;
    cgst_paise: number;
    sgst_paise: number;
    igst_paise: number;
    total_tax_paise: number;
    total_gross_paise: number;
  }[];
  invoice_details: {
    invoice_number: string;
    business_date: string;
    created_at: string;
    sale_status: string;
    taxable_paise: number;
    cgst_paise: number;
    sgst_paise: number;
    igst_paise: number;
    total_tax_paise: number;
    round_off_paise: number;
    net_payable_paise: number;
    hsn_summary: string;
  }[];
}

export interface ProductSalesReport {
  total_items_sold_count: number;
  total_revenue_paise: number;
  products: {
    product_id: string;
    product_name: string;
    tamil_name: string;
    sku: string;
    category_id: string;
    pricing_unit: string;
    total_quantity_canonical: number;
    quantity_formatted: string;
    bills_count: number;
    taxable_paise: number;
    tax_paise: number;
    gross_paise: number;
    revenue_share_percent: number;
  }[];
  categories: {
    category_id: string;
    category_name: string;
    items_count: number;
    taxable_paise: number;
    tax_paise: number;
    gross_paise: number;
    revenue_share_percent: number;
  }[];
  top_selling: {
    product_id: string;
    product_name: string;
    tamil_name: string;
    sku: string;
    category_id: string;
    pricing_unit: string;
    total_quantity_canonical: number;
    quantity_formatted: string;
    bills_count: number;
    taxable_paise: number;
    tax_paise: number;
    gross_paise: number;
    revenue_share_percent: number;
  }[];
}

export interface CashDrawerReport {
  session_id: string | null;
  opening_float_paise: number;
  cash_sales_inflow_paise: number;
  cash_refunds_outflow_paise: number;
  manual_inflows_paise: number;
  manual_outflows_paise: number;
  net_cash_change_paise: number;
  expected_closing_cash_paise: number;
  recorded_closing_cash_paise: number | null;
  variance_paise: number | null;
  movements: {
    id: string;
    created_at: string;
    movement_type: string;
    direction: string;
    amount_paise: number;
    reference_id: string;
    session_id: string;
  }[];
}

export interface FinancialReportsAggregate {
  daily_sales: DailySalesSummary;
  payment_summary: PaymentSummaryReport;
  gst_report: GstReport;
  product_sales: ProductSalesReport;
  cash_drawer: CashDrawerReport;
}


export interface SessionInfo {
  token: string;
  user_id: string;
  username: string;
  display_name: string;
  role: 'ADMIN' | 'CASHIER';
  branch_id: string;
  terminal_id: string;
  counter_id: string;
  session_id: string;
  permissions: string[];
  expires_at: string;
}

export interface UserRecord {
  id: string;
  username: string;
  display_name: string;
  role: 'ADMIN' | 'CASHIER';
  status: 'ACTIVE' | 'DISABLED';
  created_at: string;
  updated_at: string;
}

export interface AuditEventRecord {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  actor_id: string;
  created_at: string;
}

export interface BranchConfigState {
  branch_id: string;
  branch_name: string;
  terminal_id: string;
  counter_id: string;
  cloud_api_url: string;
  cloud_api_key: string;
  auto_sync_enabled: boolean;
}

export interface SyncStatusState {
  branch_id: string;
  branch_name: string;
  terminal_id: string;
  cloud_api_url: string;
  pending_count: number;
  synced_count: number;
  conflict_count: number;
  total_outbox_count: number;
  last_sync_timestamp: string | null;
  last_sync_status: string;
  last_sync_error: string | null;
  is_online: boolean;
  last_inbound_sync_timestamp?: string | null;
  last_inbound_sync_status?: string;
  last_inbound_sync_error?: string | null;
  last_inbound_catalog_version?: number;
  auto_sync_worker_active?: boolean;
}

export interface CatalogCategory {
  id: string;
  name: string;
  tamil_name: string;
  icon: string;
  sku_prefix?: string;
}

const defaultCatalogCategories: CatalogCategory[] = [
  { id: 'all', name: 'All Items', tamil_name: 'அனைத்தும்', icon: '🍽️' },
  { id: 'cat_sweets', name: 'Sweets', tamil_name: 'இனிப்புகள்', icon: '🧈', sku_prefix: 'SWT' },
  { id: 'cat_savories', name: 'Savouries', tamil_name: 'கார வகைகள்', icon: '🥨', sku_prefix: 'SAV' },
  { id: 'cat_bakery', name: 'Bakery', tamil_name: 'பேக்கரி', icon: '🥖', sku_prefix: 'BAK' },
  { id: 'cat_beverages', name: 'Drinks & Dairy', tamil_name: 'பானங்கள்', icon: '🥛', sku_prefix: 'BEV' },
];

const defaultCatalog: (ProductDefinition & { icon: string })[] = [
  {
    id: 'prod_mysore_pak',
    name: 'Special Ghee Mysore Pak',
    tamil_name: 'நெய் மைசூர் பாகு',
    sku: 'SWT-MP-001',
    category_id: 'cat_sweets',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 68000, // ₹680.00 / kg
    tax_rate_bps: 500,       // 5% GST
    hsn_code: '21069099',
    is_active: true,
    icon: '🧈',
  },
  {
    id: 'prod_madurai_laddu',
    name: 'Madurai Nei Laddu',
    tamil_name: 'மதுரை நெய் லட்டு',
    sku: 'SWT-LD-002',
    category_id: 'cat_sweets',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 44000, // ₹440.00 / kg
    tax_rate_bps: 500,
    hsn_code: '21069099',
    is_active: true,
    icon: '🟡',
  },
  {
    id: 'prod_kaju_katli',
    name: 'Royal Kaju Katli',
    tamil_name: 'காஜூ கத்திலி',
    sku: 'SWT-KK-003',
    category_id: 'cat_sweets',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 95000, // ₹950.00 / kg
    tax_rate_bps: 500,
    hsn_code: '21069099',
    is_active: true,
    icon: '💎',
  },
  {
    id: 'prod_wheat_halwa',
    name: 'Tirunelveli Wheat Halwa',
    tamil_name: 'திருநெல்வேலி கோதுமை அல்வா',
    sku: 'SWT-TH-004',
    category_id: 'cat_sweets',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 48000, // ₹480.00 / kg
    tax_rate_bps: 500,
    hsn_code: '21069099',
    is_active: true,
    icon: '🍯',
  },
  {
    id: 'prod_ribbon_pakoda',
    name: 'Madurai Ribbon Pakoda',
    tamil_name: 'ரிப்பன் பகோடா',
    sku: 'SAV-RP-005',
    category_id: 'cat_savories',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 38000, // ₹380.00 / kg
    tax_rate_bps: 500,
    hsn_code: '21069099',
    is_active: true,
    icon: '🥨',
  },
  {
    id: 'prod_kara_sev',
    name: 'Sattur Spicy Kara Sev',
    tamil_name: 'சாத்தூர் காராசேவ்',
    sku: 'SAV-KS-006',
    category_id: 'cat_savories',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 36000, // ₹360.00 / kg
    tax_rate_bps: 500,
    hsn_code: '21069099',
    is_active: true,
    icon: '🌶️',
  },
  {
    id: 'prod_butter_murukku',
    name: 'Traditional Butter Murukku',
    tamil_name: 'வெண்ணெய் முறுக்கு',
    sku: 'SAV-BM-007',
    category_id: 'cat_savories',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 42000, // ₹420.00 / kg
    tax_rate_bps: 500,
    hsn_code: '21069099',
    is_active: true,
    icon: '🌀',
  },
  {
    id: 'prod_sweet_bun',
    name: 'Coconut Honey Sweet Bun',
    tamil_name: 'தேங்காய் பன்',
    sku: 'BAK-SB-008',
    category_id: 'cat_bakery',
    pricing_unit: 'PER_PIECE',
    inventory_unit: 'PIECE',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 2500, // ₹25.00 / piece
    tax_rate_bps: 500,
    hsn_code: '19059010',
    is_active: true,
    icon: '🥖',
  },
  {
    id: 'prod_butter_rusk',
    name: 'Malgudi Crunchy Butter Rusk',
    tamil_name: 'மால்குடி ரஸ்க் பாக்கெட்',
    sku: 'BAK-BR-009',
    category_id: 'cat_bakery',
    pricing_unit: 'PER_PACK',
    inventory_unit: 'PACK',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 4500, // ₹45.00 / pack
    tax_rate_bps: 500,
    hsn_code: '19059010',
    is_active: true,
    icon: '🍞',
  },
  {
    id: 'prod_badam_milk',
    name: 'Kesar Badam Milk (Cold Bottle)',
    tamil_name: 'குங்குமப்பூ பாதாம் பால்',
    sku: 'BEV-BM-010',
    category_id: 'cat_beverages',
    pricing_unit: 'PER_PIECE',
    inventory_unit: 'PIECE',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 6000, // ₹60.00 / bottle
    tax_rate_bps: 500,
    hsn_code: '22029990',
    is_active: true,
    icon: '🥛',
  },
  {
    id: 'prod_jigarthanda',
    name: 'Famous Madurai Special Jigarthanda',
    tamil_name: 'மதுரை ஸ்பெஷல் ஜிகர்தண்டா',
    sku: 'BEV-JT-011',
    category_id: 'cat_beverages',
    pricing_unit: 'PER_PIECE',
    inventory_unit: 'PIECE',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 8000, // ₹80.00 / glass
    tax_rate_bps: 500,
    hsn_code: '22029990',
    is_active: true,
    icon: '🍧',
  },
  {
    id: 'prod_filter_coffee',
    name: 'Madurai Degree Filter Coffee',
    tamil_name: 'மதுரை டிகிரி பில்டர் காபி',
    sku: 'BEV-FC-012',
    category_id: 'cat_beverages',
    pricing_unit: 'PER_PIECE',
    inventory_unit: 'PIECE',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 3500, // ₹35.00 / cup
    tax_rate_bps: 500,
    hsn_code: '09012190',
    is_active: true,
    icon: '☕',
  },
];

export const generateNextSku = (
  catId: string,
  currentCatalog: { sku: string }[],
  allCategories: CatalogCategory[]
): string => {
  const cat = allCategories.find(c => c.id === catId);
  const prefix = (
    cat?.sku_prefix ||
    (cat ? cat.name.replace(/[^a-zA-Z]/g, '').slice(0, 3) : 'ITM') ||
    'ITM'
  ).toUpperCase();

  const regex = new RegExp(`^${prefix}[-_]?0*(\\d+)`, 'i');
  let maxNum = 0;
  currentCatalog.forEach(p => {
    const m = p.sku.match(regex);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  });

  const nextNum = maxNum + 1;
  const pad = nextNum < 100 ? (nextNum < 10 ? `00${nextNum}` : `0${nextNum}`) : `${nextNum}`;
  let candidate = `${prefix}-${pad}`;

  let counter = nextNum;
  while (currentCatalog.some(p => p.sku.trim().toUpperCase() === candidate.toUpperCase())) {
    counter++;
    const pStr = counter < 100 ? (counter < 10 ? `00${counter}` : `0${counter}`) : `${counter}`;
    candidate = `${prefix}-${pStr}`;
  }
  return candidate;
};

export const App: React.FC = () => {
  const isTauriRuntime = typeof window !== 'undefined' && !!window.__TAURI__?.core;

  // --- 1. Authentication & Session State ---
  const [isProvisioned, setIsProvisioned] = useState<boolean>(true);
  const [currentSession, setCurrentSession] = useState<SessionInfo | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Login form state
  const [loginUsername, setLoginUsername] = useState<string>('');
  const [loginPin, setLoginPin] = useState<string>('');

  // Owner provisioning form state
  const [provUsername, setProvUsername] = useState<string>('owner');
  const [provDisplayName, setProvDisplayName] = useState<string>('Thiru Murugan (Store Owner)');
  const [provPin, setProvPin] = useState<string>('');
  const [provConfirmPin, setProvConfirmPin] = useState<string>('');
  const [provBranchId, setProvBranchId] = useState<string>('IB');
  const [provTerminalId, setProvTerminalId] = useState<string>('T1');

  // Cashier Handover Modal state
  const [isSwitchModalOpen, setIsSwitchModalOpen] = useState<boolean>(false);
  const [switchUsername, setSwitchUsername] = useState<string>('');
  const [switchPin, setSwitchPin] = useState<string>('');
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Navigation tab state
  const [activeTab, setActiveTab] = useState<'billing' | 'owner_panel'>('billing');

  // Owner administration state
  const [userList, setUserList] = useState<UserRecord[]>([]);
  const [securityLogs, setSecurityLogs] = useState<AuditEventRecord[]>([]);
  const [newCashierUsername, setNewCashierUsername] = useState<string>('');
  const [newCashierDisplayName, setNewCashierDisplayName] = useState<string>('');
  const [newCashierRole, setNewCashierRole] = useState<'CASHIER' | 'ADMIN'>('CASHIER');
  const [newCashierPin, setNewCashierPin] = useState<string>('');
  const [adminActionMessage, setAdminActionMessage] = useState<string | null>(null);
  const [adminActionError, setAdminActionError] = useState<string | null>(null);
  const [resetPinUserId, setResetPinUserId] = useState<string | null>(null);
  const [resetPinValue, setResetPinValue] = useState<string>('');

  // --- Dynamic Authoritative Product Catalog & Inventory State ---
  const [catalog, setCatalog] = useState<DBProductRecord[]>(() =>
    defaultCatalog.map(p => ({
      ...p,
      barcode: null,
      current_stock: 25000000,
      stock_unit: p.inventory_unit,
      created_at: '',
      updated_at: '',
    }))
  );
  const [catalogLoading, setCatalogLoading] = useState<boolean>(false);
  const [ownerSubTab, setOwnerSubTab] = useState<'products' | 'stock' | 'reports' | 'users_security' | 'cloud_sync' | 'updates'>('products');
  const [ownerProductSearch, setOwnerProductSearch] = useState<string>('');
  const [ownerCategoryFilter, setOwnerCategoryFilter] = useState<string>('all');
  const [ownerStatusFilter, setOwnerStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  // --- OTA Software Updates State (Tauri v2 Auto-Updater) ---
  const [availableUpdate, setAvailableUpdate] = useState<TauriUpdate | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState<boolean>(false);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [updateProgressPercent, setUpdateProgressPercent] = useState<number>(0);
  const [updateStatusMessage, setUpdateStatusMessage] = useState<string | null>(null);
  const [updateErrorMessage, setUpdateErrorMessage] = useState<string | null>(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState<boolean>(false);
  const currentAppVersion = '2.9.16';

  // --- Cloud Sync & Multi-Branch State ---
  const [syncStatus, setSyncStatus] = useState<SyncStatusState | null>(null);
  const [syncConfig, setSyncConfig] = useState<BranchConfigState | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncConfigForm, setSyncConfigForm] = useState<BranchConfigState>({
    branch_id: 'IB',
    branch_name: 'Iyer Bungalow Branch (IB)',
    terminal_id: 'T1',
    counter_id: 'C1',
    cloud_api_url: 'http://127.0.0.1:3000',
    cloud_api_key: 'malgudi_sync_secret_token_2026',
    auto_sync_enabled: true,
  });
  const [isSavingBranchConfig, setIsSavingBranchConfig] = useState<boolean>(false);
  const [branchConfigSavedSuccess, setBranchConfigSavedSuccess] = useState<boolean>(false);

  // --- Reports State ---
  const [reportsLoading, setReportsLoading] = useState<boolean>(false);
  const [reportsError, setReportsError] = useState<string | null>(null);
  const [activeReportView, setActiveReportView] = useState<'daily' | 'payments' | 'gst' | 'products' | 'drawer' | 'zreport'>('daily');
  const [reportStartDate, setReportStartDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [reportEndDate, setReportEndDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [reportsData, setReportsData] = useState<FinancialReportsAggregate | null>(null);

  // Product Add/Edit Modal state
  const [isProductModalOpen, setIsProductModalOpen] = useState<boolean>(false);
  const [editingProduct, setEditingProduct] = useState<DBProductRecord | null>(null);
  const [prodFormName, setProdFormName] = useState<string>('');
  const [prodFormTamilName, setProdFormTamilName] = useState<string>('');
  const [prodFormSku, setProdFormSku] = useState<string>('');
  const [prodFormBarcode, setProdFormBarcode] = useState<string>('');
  const [prodFormCategory, setProdFormCategory] = useState<string>('cat_sweets');
  const [prodFormPricingUnit, setProdFormPricingUnit] = useState<PricingUnit>('PER_KG');
  const [prodFormInventoryUnit, setProdFormInventoryUnit] = useState<InventoryUnit>('MG');
  const [prodFormPriceRupees, setProdFormPriceRupees] = useState<string>('500');
  const [prodFormGstPercent, setProdFormGstPercent] = useState<number>(5);
  const [prodFormHsn, setProdFormHsn] = useState<string>('21069099');
  const [prodFormInitialStock, setProdFormInitialStock] = useState<string>('25');
  const [prodFormError, setProdFormError] = useState<string | null>(null);

  // Stock Adjustment Modal & Movement Log state
  const [isStockAdjustModalOpen, setIsStockAdjustModalOpen] = useState<boolean>(false);
  const [adjustProductId, setAdjustProductId] = useState<string>('');
  const [adjustMovementType, setAdjustMovementType] = useState<string>('RECEIPT_PRODUCTION');
  const [adjustQuantity, setAdjustQuantity] = useState<string>('10');
  const [adjustReason, setAdjustReason] = useState<string>('');
  const [adjustReferenceId, setAdjustReferenceId] = useState<string>('');
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [stockMovements, setStockMovements] = useState<StockMovementRecord[]>([]);
  const [adjustProductSearch, setAdjustProductSearch] = useState<string>('');
  const [stockTableSearch, setStockTableSearch] = useState<string>('');
  const [stockTableFilter, setStockTableFilter] = useState<'all' | 'out_of_stock' | 'low_stock'>('all');
  const [stockTableCategory, setStockTableCategory] = useState<string>('all');

  // Category State & Management
  const [categories, setCategories] = useState<CatalogCategory[]>(() => {
    try {
      const saved = typeof window !== 'undefined' ? localStorage.getItem('pos_custom_categories') : null;
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return defaultCatalogCategories;
  });
  const [isAddCategoryModalOpen, setIsAddCategoryModalOpen] = useState<boolean>(false);
  const [newCatName, setNewCatName] = useState<string>('');
  const [newCatTamilName, setNewCatTamilName] = useState<string>('');
  const [newCatIcon, setNewCatIcon] = useState<string>('📦');
  const [newCatSkuPrefix, setNewCatSkuPrefix] = useState<string>('');

  // Void Sale Confirmation Modal state
  const [voidTargetSale, setVoidTargetSale] = useState<FinalizeSaleResult | null>(null);
  const [voidReason, setVoidReason] = useState<string>('');
  const [voidError, setVoidError] = useState<string | null>(null);

  // --- Pagination States for Key Admin & Audit Ledgers ---
  const [ownerProductsPage, setOwnerProductsPage] = useState<number>(1);
  const OWNER_PRODUCTS_PER_PAGE = 15;

  const [stockMovementsPage, setStockMovementsPage] = useState<number>(1);
  const STOCK_MOVEMENTS_PER_PAGE = 15;

  const [drawerMovementsPage, setDrawerMovementsPage] = useState<number>(1);
  const DRAWER_MOVEMENTS_PER_PAGE = 15;

  const [securityLogsPage, setSecurityLogsPage] = useState<number>(1);
  const SECURITY_LOGS_PER_PAGE = 15;

  const [invoicesSearch, setInvoicesSearch] = useState<string>('');
  const [invoicesPage, setInvoicesPage] = useState<number>(1);
  const INVOICES_PER_PAGE = 10;

  const renderPaginationBar = (
    currentPage: number,
    totalItems: number,
    itemsPerPage: number,
    onPageChange: (newPage: number) => void
  ) => {
    const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
    if (totalItems <= itemsPerPage && currentPage === 1) return null;
    const startItem = totalItems === 0 ? 0 : (currentPage - 1) * itemsPerPage + 1;
    const endItem = Math.min(currentPage * itemsPerPage, totalItems);

    return (
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', backgroundColor: '#FAF9F7', borderTop: '1px solid #E5E5DF', borderRadius: '0 0 6px 6px', fontSize: 12 }}>
        <span style={{ color: '#666' }}>
          Showing <strong>{startItem}</strong> - <strong>{endItem}</strong> of <strong>{totalItems}</strong> entries
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            style={{
              padding: '4px 10px',
              border: '1px solid #ccc',
              borderRadius: 4,
              backgroundColor: currentPage <= 1 ? '#eee' : '#fff',
              color: currentPage <= 1 ? '#999' : '#333',
              cursor: currentPage <= 1 ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            ◀ Prev
          </button>
          <span style={{ padding: '0 6px', fontWeight: 700, color: '#8B1E2D' }}>
            Page {currentPage} of {totalPages}
          </span>
          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => onPageChange(currentPage + 1)}
            style={{
              padding: '4px 10px',
              border: '1px solid #ccc',
              borderRadius: 4,
              backgroundColor: currentPage >= totalPages ? '#eee' : '#fff',
              color: currentPage >= totalPages ? '#999' : '#333',
              cursor: currentPage >= totalPages ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            Next ▶
          </button>
        </div>
      </div>
    );
  };

  // --- 2. Catalog & Product Filter State ---
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Weight Entry Dialog state (for PER_KG and unit products)
  const [weightModalProduct, setWeightModalProduct] = useState<DBProductRecord | null>(null);
  const [weightModalGrams, setWeightModalGrams] = useState<number>(250);
  const [weightModalUnit, setWeightModalUnit] = useState<'g' | 'kg' | 'pc'>('g');
  const [weightModalKgInput, setWeightModalKgInput] = useState<string>('0.25');
  const [weightModalCartIndex, setWeightModalCartIndex] = useState<number | null>(null);

  // --- 3. Active Order / Cart State ---
  // Cart initializes completely empty on clean application startup
  const [cartItems, setCartItems] = useState<SaleItemAllocation[]>([]);

  const subtotalTaxablePaise = cartItems.reduce((sum, item) => sum + item.taxable_paise, 0);
  const totalCgstPaise = cartItems.reduce((sum, item) => sum + item.cgst_paise, 0);
  const totalSgstPaise = cartItems.reduce((sum, item) => sum + item.sgst_paise, 0);
  const totalGrossPaise = cartItems.reduce((sum, item) => sum + item.gross_paise, 0);

  // --- 4. Payment Tender Reconciliation State ---
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState<boolean>(false);
  const [isUpiModalOpen, setIsUpiModalOpen] = useState<boolean>(false);
  const [upiSimulatedVerified, setUpiSimulatedVerified] = useState<boolean>(true);
  const [cashTenderedRupees, setCashTenderedRupees] = useState<number>(0);
  const [upiAllocatedRupees, setUpiAllocatedRupees] = useState<number>(0);
  const [upiVerificationSource] = useState<PaymentVerificationSource>('SOUNDBOX_BROADCAST');
  const [settlementPolicy, setSettlementPolicy] = useState<SettlementPolicy>(() => {
    return 'CASHIER_ASSERTION_PERMITTED';
  });

  // Automatically derive cash allocated to bill (Exact paise arithmetic — zero split tender mismatch)
  const derivedCashAllocatedPaise = Math.max(0, totalGrossPaise - Math.round(upiAllocatedRupees * 100));
  const derivedCashAllocatedRupees = derivedCashAllocatedPaise / 100;
  const changeReturnedPaise = Math.max(0, Math.round(cashTenderedRupees * 100) - derivedCashAllocatedPaise);

  // Store settlement policy updater for Owner/Admin Settings
  const handleUpdateSettlementPolicy = (newPolicy: SettlementPolicy) => {
    setSettlementPolicy(newPolicy);
    if (typeof window !== 'undefined') {
      localStorage.setItem('malgudi_settlement_policy', newPolicy);
    }
    setAdminActionMessage(`Store settlement policy updated to: ${newPolicy === 'STRICT_GATEWAY_ONLY' ? 'Strict Gateway Only' : 'Soundbox Audio Permitted'}`);
    setTimeout(() => setAdminActionMessage(null), 4000);
  };

  // --- 5. Modals & Persistence State ---
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState<boolean>(false);
  const [isFinalizing, setIsFinalizing] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [persistedHistory, setPersistedHistory] = useState<FinalizeSaleResult[]>([]);
  const [activeReceiptModal, setActiveReceiptModal] = useState<DetailedSaleReceipt | null>(null);
  const [dbInfo, setDbInfo] = useState<{ db_path: string; is_wal_active: boolean; total_sales: number; pending_sync_count: number } | null>(null);

  // --- Opening Cash Float & Live Till Drawer State ---
  const [isOpeningFloatModalOpen, setIsOpeningFloatModalOpen] = useState<boolean>(false);
  const [openingFloatStatus, setOpeningFloatStatus] = useState<OpeningFloatStatus | null>(null);
  const [liveDrawerSummary, setLiveDrawerSummary] = useState<LiveCashDrawerSummary | null>(null);
  const [showDrawerBreakdown, setShowDrawerBreakdown] = useState<boolean>(false);
  const [openingFloatInput, setOpeningFloatInput] = useState<string>('2000');
  const [openingFloatNotes, setOpeningFloatNotes] = useState<string>('');
  const [isOpeningFloatSubmitting, setIsOpeningFloatSubmitting] = useState<boolean>(false);
  const currentSessionRef = useRef<SessionInfo | null>(currentSession);
  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  // --- Optional Customer Info State ---
  const [customerInfo, setCustomerInfo] = useState<{
    name: string;
    phone: string;
    location: string;
  } | null>(null);
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState<boolean>(false);
  const [customerForm, setCustomerForm] = useState({ name: '', phone: '', location: '' });
  const [customerPhoneError, setCustomerPhoneError] = useState<string | null>(null);

  // --- Day-End Close (Z-Report) State ---
  const [isDayCloseModalOpen, setIsDayCloseModalOpen] = useState<boolean>(false);
  const [liveDrawerExpectedPaise, setLiveDrawerExpectedPaise] = useState<number>(0);
  const [liveDrawerOpeningPaise, setLiveDrawerOpeningPaise] = useState<number>(0);
  const [liveDrawerCashSalesPaise, setLiveDrawerCashSalesPaise] = useState<number>(0);
  const [isManualVarianceExpanded, setIsManualVarianceExpanded] = useState<boolean>(false);
  const [countedClosingCashInput, setCountedClosingCashInput] = useState<string>('');
  const [dayCloseNotes, setDayCloseNotes] = useState<string>('');
  const [isDayCloseSubmitting, setIsDayCloseSubmitting] = useState<boolean>(false);
  const [activeZReportModal, setActiveZReportModal] = useState<DayEndSummary | null>(null);
  const [archiveZReportDate, setArchiveZReportDate] = useState<string>(() => new Date().toISOString().split('T')[0]);
  const [archiveZReportLoading, setArchiveZReportLoading] = useState<boolean>(false);
  const [archiveZReportData, setArchiveZReportData] = useState<DayEndSummary | null>(null);

  // Helper: Open Detailed Receipt Reprint (Fetches line items & payments from SQLite)
  const handleOpenReceiptReprint = async (invoiceNumber: string, fallbackSummary?: FinalizeSaleResult) => {
    if (isTauriRuntime) {
      try {
        const detailed = await window.__TAURI__!.core.invoke<DetailedSaleReceipt>('get_sale_details', {
          sessionToken: currentSession?.token,
          invoiceOrSaleId: invoiceNumber,
        });
        setActiveReceiptModal(detailed);
        return;
      } catch (e) {
        console.error('Failed to get sale details via Tauri:', e);
      }
    }

    if (fallbackSummary) {
      const mockReceipt: DetailedSaleReceipt = {
        sale_id: fallbackSummary.sale_id,
        invoice_number: fallbackSummary.invoice_number,
        business_date: fallbackSummary.created_at.substring(0, 10),
        created_at: fallbackSummary.created_at,
        cashier_name: currentSession?.display_name || 'Staff Cashier',
        terminal_id: currentSession?.terminal_id || 'T1',
        branch_id: currentSession?.branch_id || 'IB',
        branch_name: syncConfig?.branch_name || 'Iyer Bungalow Branch (IB)',
        subtotal_taxable_paise: Math.round(fallbackSummary.net_payable_paise / 1.05),
        total_cgst_paise: Math.round((fallbackSummary.net_payable_paise - Math.round(fallbackSummary.net_payable_paise / 1.05)) / 2),
        total_sgst_paise: Math.round((fallbackSummary.net_payable_paise - Math.round(fallbackSummary.net_payable_paise / 1.05)) / 2),
        round_off_paise: 0,
        net_payable_paise: fallbackSummary.net_payable_paise,
        sale_status: fallbackSummary.sale_status || 'FINALIZED',
        payment_status: fallbackSummary.payment_status || 'SETTLED',
        items: [],
        payments: [
          {
            payment_method: fallbackSummary.cash_retained_paise > 0 ? 'CASH' : 'UPI',
            allocated_amount_paise: fallbackSummary.net_payable_paise,
            tendered_paise: fallbackSummary.cash_retained_paise || fallbackSummary.net_payable_paise,
            change_returned_paise: 0,
            net_amount_paise: fallbackSummary.net_payable_paise,
          }
        ],
      };
      setActiveReceiptModal(mockReceipt);
    }
  };

  // Helper: Load Live Cash Drawer Summary (ACID ledger from SQLite)
  const loadLiveDrawerSummary = async (token?: string) => {
    const activeToken = token || currentSessionRef.current?.token || currentSession?.token;
    if (!activeToken) return;
    if (isTauriRuntime) {
      try {
        const summary = await window.__TAURI__!.core.invoke<LiveCashDrawerSummary>('cash_get_live_drawer_summary', {
          sessionToken: activeToken,
        });
        setLiveDrawerSummary(summary);
      } catch (e) {
        console.error('Failed to load live drawer summary via Tauri:', e);
      }
    } else {
      // Simulation / Web fallback
      const floatPaise = openingFloatStatus?.opening_float_paise || 0;
      const today = new Date().toISOString().substring(0, 10);
      const cashSales = persistedHistory
        .filter(s => s.payment_status === 'SETTLED' && s.sale_status !== 'VOIDED' && (s.created_at || '').startsWith(today))
        .reduce((sum, s) => sum + (s.cash_retained_paise || 0), 0);
      const simulatedSummary: LiveCashDrawerSummary = {
        has_opening_float: openingFloatStatus?.has_opening_float ?? false,
        opening_float_paise: floatPaise,
        cash_sales_paise: cashSales,
        cash_refunds_paise: 0,
        current_drawer_cash_paise: floatPaise + cashSales,
        is_day_closed: openingFloatStatus?.is_day_closed ?? false,
        business_date: today,
        branch_id: currentSession?.branch_id || 'IB',
        recorded_at: openingFloatStatus?.recorded_at || null,
      };
      setLiveDrawerSummary(simulatedSummary);
    }
  };

  // Helper: Check Opening Float Status for Today
  const checkOpeningFloatStatus = async (token?: string) => {
    const activeToken = token || currentSessionRef.current?.token || currentSession?.token;
    if (!activeToken) return;
    if (isTauriRuntime) {
      try {
        const status = await window.__TAURI__!.core.invoke<OpeningFloatStatus>('cash_check_opening_float', {
          sessionToken: activeToken,
        });
        setOpeningFloatStatus(status);
        await loadLiveDrawerSummary(activeToken);
        if (!status.has_opening_float && !status.is_day_closed) {
          setIsOpeningFloatModalOpen(true);
        }
      } catch (e) {
        console.error('Failed to check opening float:', e);
      }
    } else {
      await loadLiveDrawerSummary(activeToken);
      if (!openingFloatStatus?.has_opening_float && !openingFloatStatus?.is_day_closed) {
        setIsOpeningFloatModalOpen(true);
      }
    }
  };

  // Handler: Confirm Morning Opening Float
  const handleConfirmOpeningFloat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession) return;
    const amountRupees = parseFloat(openingFloatInput);
    if (isNaN(amountRupees) || amountRupees < 0) {
      alert('Please enter a valid non-negative starting cash float.');
      return;
    }
    const amountPaise = Math.round(amountRupees * 100);
    setIsOpeningFloatSubmitting(true);
    try {
      if (isTauriRuntime) {
        const res = await window.__TAURI__!.core.invoke<OpeningFloatStatus>('cash_record_opening_float', {
          sessionToken: currentSession.token,
          amountPaise,
          notes: openingFloatNotes.trim() || undefined,
        });
        setOpeningFloatStatus(res);
        await loadLiveDrawerSummary(currentSession.token);
      } else {
        const simStatus: OpeningFloatStatus = {
          has_opening_float: true,
          opening_float_paise: amountPaise,
          session_id: currentSession.session_id,
          business_date: new Date().toISOString().substring(0, 10),
          recorded_at: new Date().toISOString(),
          is_day_closed: false,
        };
        setOpeningFloatStatus(simStatus);
        setLiveDrawerSummary({
          has_opening_float: true,
          opening_float_paise: amountPaise,
          cash_sales_paise: 0,
          cash_refunds_paise: 0,
          current_drawer_cash_paise: amountPaise,
          is_day_closed: false,
          business_date: simStatus.business_date,
          branch_id: currentSession.branch_id,
          recorded_at: simStatus.recorded_at,
        });
      }
      setIsOpeningFloatModalOpen(false);
    } catch (err: any) {
      alert('Error recording starting cash float: ' + (err.message || String(err)));
    } finally {
      setIsOpeningFloatSubmitting(false);
    }
  };

  // Handler: Open Day-End Close Modal with Live Expected Cash (100% Pre-calculated)
  const handleOpenDayCloseModal = async () => {
    if (!currentSession) return;
    setIsDayCloseModalOpen(true);
    setIsManualVarianceExpanded(false);
    setDayCloseNotes('');

    const todayStr = new Date().toISOString().split('T')[0];
    const fallbackOpening = openingFloatStatus?.opening_float_paise || 200000;
    const fallbackCashSales = persistedHistory
      .filter(h => h.sale_status !== 'VOIDED' && (h.created_at || '').startsWith(todayStr))
      .reduce((sum, h) => sum + (h.cash_retained_paise || 0), 0);
    const fallbackExpected = fallbackOpening + fallbackCashSales;

    setLiveDrawerOpeningPaise(fallbackOpening);
    setLiveDrawerCashSalesPaise(fallbackCashSales);
    setLiveDrawerExpectedPaise(fallbackExpected);
    setCountedClosingCashInput((fallbackExpected / 100).toFixed(2));

    if (isTauriRuntime) {
      try {
        const drawerReport = await window.__TAURI__!.core.invoke<any>('reports_get_cash_drawer', {
          sessionToken: currentSession.token,
          filter: {
            start_date: todayStr,
            end_date: todayStr,
            branch_id: currentSession.branch_id || 'IB',
          },
        });
        if (drawerReport) {
          const opening = drawerReport.opening_float_paise || 0;
          const cashSales = drawerReport.cash_sales_inflow_paise || 0;
          const expected = drawerReport.expected_closing_cash_paise || (opening + cashSales);
          setLiveDrawerOpeningPaise(opening);
          setLiveDrawerCashSalesPaise(cashSales);
          setLiveDrawerExpectedPaise(expected);
          setCountedClosingCashInput((expected / 100).toFixed(2));
        }
      } catch (e) {
        console.error('Failed to pre-fill closing cash:', e);
      }
    }
  };

  // Handler: Execute Day Close & Produce Z-Report (1-Click or Manual Variance)
  const handleExecuteDayClose = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentSession) return;
    const countedRupees = parseFloat(countedClosingCashInput);
    if (isNaN(countedRupees) || countedRupees < 0) {
      alert('Please enter a valid non-negative counted physical cash amount.');
      return;
    }
    setIsDayCloseSubmitting(true);
    try {
      if (isTauriRuntime) {
        const summary = await window.__TAURI__!.core.invoke<DayEndSummary>('cash_record_day_close', {
          sessionToken: currentSession.token,
          countedCashPaise: Math.round(countedRupees * 100),
          notes: dayCloseNotes.trim() || undefined,
        });
        setIsDayCloseModalOpen(false);
        setActiveZReportModal(summary);
        if (openingFloatStatus) {
          setOpeningFloatStatus({ ...openingFloatStatus, is_day_closed: true });
        }
        await loadLiveDrawerSummary(currentSession.token);
      } else {
        const today = new Date().toISOString().split('T')[0];
        const mockSummary: DayEndSummary = {
          business_date: today,
          branch_name: syncConfig?.branch_name || 'Iyer Bungalow Branch (IB)',
          terminal_id: currentSession.terminal_id || 'T1',
          session_id: currentSession.session_id,
          closed_by_user: currentSession.username,
          closed_at: new Date().toISOString(),
          opening_float_paise: (openingFloatStatus?.opening_float_paise || 200000),
          cash_sales_paise: totalGrossPaise,
          cash_refunds_paise: 0,
          expected_closing_cash_paise: (openingFloatStatus?.opening_float_paise || 200000) + totalGrossPaise,
          counted_closing_cash_paise: Math.round(countedRupees * 100),
          variance_paise: Math.round(countedRupees * 100) - ((openingFloatStatus?.opening_float_paise || 200000) + totalGrossPaise),
          variance_notes: dayCloseNotes.trim() || null,
          total_bills_recorded: persistedHistory.length,
          active_bills_count: persistedHistory.filter(h => h.sale_status !== 'VOIDED').length,
          voided_bills_count: persistedHistory.filter(h => h.sale_status === 'VOIDED').length,
          gross_sales_paise: totalGrossPaise,
          net_sales_paise: totalGrossPaise,
          cash_realized_paise: totalGrossPaise,
          upi_realized_paise: 0,
          total_taxable_paise: Math.round(totalGrossPaise / 1.05),
          total_cgst_paise: Math.round((totalGrossPaise - Math.round(totalGrossPaise / 1.05)) / 2),
          total_sgst_paise: Math.round((totalGrossPaise - Math.round(totalGrossPaise / 1.05)) / 2),
          total_tax_paise: totalGrossPaise - Math.round(totalGrossPaise / 1.05),
          pending_sync_count: 0,
        };
        setIsDayCloseModalOpen(false);
        setActiveZReportModal(mockSummary);
      }
    } catch (err: any) {
      alert('Failed to record day close: ' + (err.message || String(err)));
    } finally {
      setIsDayCloseSubmitting(false);
    }
  };

  // Handler: Load Historical Z-Report for Any Past Date
  const handleLoadArchiveZReport = async (targetDate: string) => {
    if (!currentSession || !isTauriRuntime) return;
    setArchiveZReportLoading(true);
    try {
      const summary = await window.__TAURI__!.core.invoke<DayEndSummary>('get_day_end_report', {
        sessionToken: currentSession.token,
        targetDate,
      });
      setArchiveZReportData(summary);
    } catch (err: any) {
      alert('Failed to load Z-Report: ' + (err.message || String(err)));
    } finally {
      setArchiveZReportLoading(false);
    }
  };

  // Initial Authentication Check & Quiet OTA Update Check
  useEffect(() => {
    checkInitialAuthStatus();
    loadSyncStatus();
    loadSyncConfig();
    const syncInterval = setInterval(() => {
      loadSyncStatus();
      if (currentSessionRef.current?.token) {
        loadLiveDrawerSummary(currentSessionRef.current.token);
      }
    }, 10000);

    // Quiet background update check 5 seconds after startup
    const updateTimer = setTimeout(() => {
      if (isTauriRuntime) {
        handleCheckForUpdates(true);
      }
    }, 5000);

    return () => {
      clearInterval(syncInterval);
      clearTimeout(updateTimer);
    };
  }, []);

  // Open Payment Modal helper: synchronizes tender with current total
  const openPaymentModal = () => {
    setCashTenderedRupees(totalGrossPaise / 100);
    setUpiAllocatedRupees(0);
    setIsPaymentModalOpen(true);
  };

  // Keyboard shortcut: Ctrl+Enter or F4 triggers payment / checkout
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (cartItems.length > 0) {
          if (isPaymentModalOpen) {
            handleFinalizeSale();
          } else if (isUpiModalOpen) {
            handleQuickUpiFinalize();
          } else {
            handleExactCashSale();
          }
        }
      } else if (e.key === 'F2') {
        e.preventDefault();
        setIsCustomerModalOpen(prev => !prev);
      } else if (e.key === 'F4') {
        e.preventDefault();
        if (cartItems.length > 0) {
          openPaymentModal();
        }
      } else if (e.key === 'Escape') {
        if (isCustomerModalOpen) setIsCustomerModalOpen(false);
        else if (weightModalProduct) setWeightModalProduct(null);
        else if (isUpiModalOpen) { setIsUpiModalOpen(false); setUpiSimulatedVerified(false); }
        else if (isPaymentModalOpen) setIsPaymentModalOpen(false);
        else if (isHistoryModalOpen) setIsHistoryModalOpen(false);
        else if (isSwitchModalOpen) setIsSwitchModalOpen(false);
        else if (activeReceiptModal) setActiveReceiptModal(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isPaymentModalOpen, isUpiModalOpen, upiSimulatedVerified, weightModalProduct, isHistoryModalOpen, isSwitchModalOpen, activeReceiptModal, isCustomerModalOpen, cartItems, totalGrossPaise, settlementPolicy]);

  const checkInitialAuthStatus = async () => {
    setAuthLoading(true);
    setAuthError(null);
    if (isTauriRuntime) {
      try {
        const status = await window.__TAURI__!.core.invoke<{ is_provisioned: boolean; active_session?: SessionInfo }>('auth_get_status', {});
        setIsProvisioned(status.is_provisioned);
        if (status.active_session) {
          setCurrentSession(status.active_session);
          loadSessionData(status.active_session.token);
        }
      } catch (err: any) {
        setAuthError(err.message || String(err));
      } finally {
        setAuthLoading(false);
      }
    } else {
      setIsProvisioned(true);
      setAuthLoading(false);
    }
  };

  const loadSessionData = async (token: string) => {
    if (isTauriRuntime) {
      try {
        const sales = await window.__TAURI__!.core.invoke<any[]>('get_recent_sales', { sessionToken: token });
        if (sales && sales.length > 0) {
          setPersistedHistory(
            sales.map(s => ({
              sale_id: s.id,
              invoice_number: s.invoice_number,
              event_id: `evt_persisted_${s.id.substring(0, 8)}`,
              payload_hash: '',
              items_count: 1,
              net_payable_paise: s.net_payable_paise,
              cash_retained_paise: 0,
              upi_settled_paise: 0,
              sale_status: s.sale_status,
              payment_status: s.payment_status,
              created_at: s.created_at,
            }))
          );
        }
        const info = await window.__TAURI__!.core.invoke<any>('get_database_info');
        setDbInfo(info);
        await refreshCatalog(token);
        await checkOpeningFloatStatus(token);
      } catch (err: any) {
        setErrorMessage('Failed to load session sales: ' + (err.message || String(err)));
      }
    }
  };

  // --- Handlers: Authentication ---
  const handleProvisionOwner = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!provUsername.trim()) {
      setAuthError('Owner username is required.');
      return;
    }
    if (provPin.length < 4) {
      setAuthError('Security PIN must be at least 4 digits.');
      return;
    }
    if (provPin !== provConfirmPin) {
      setAuthError('PIN confirmation does not match.');
      return;
    }

    try {
      if (isTauriRuntime) {
        const session = await window.__TAURI__!.core.invoke<SessionInfo>('auth_provision_owner', {
          payload: {
            username: provUsername.trim(),
            display_name: provDisplayName.trim() || provUsername.trim(),
            pin: provPin,
            branch_id: provBranchId,
            terminal_id: provTerminalId.trim() || 'T1',
            counter_id: 'C1',
          },
        });
        setIsProvisioned(true);
        setCurrentSession(session);
        loadSessionData(session.token);
      } else {
        const todayStr = new Date().toISOString().substring(0, 10).replace(/-/g, '');
        const simSession: SessionInfo = {
          token: 'sim_owner_token',
          user_id: 'usr_owner',
          username: provUsername.trim(),
          display_name: provDisplayName.trim() || 'Store Owner',
          role: 'ADMIN',
          branch_id: provBranchId,
          terminal_id: provTerminalId.trim() || 'T1',
          counter_id: 'C1',
          session_id: `sess_${provBranchId}_${todayStr}_owner`,
          permissions: ['billing:finalize_sale', 'billing:reprint_receipt', 'admin:manage_users', 'admin:view_audit_logs', 'admin:create_backup'],
          expires_at: new Date(Date.now() + 28800000).toISOString(),
        };
        setIsProvisioned(true);
        setCurrentSession(simSession);
      }
    } catch (err: any) {
      setAuthError(err.message || String(err));
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (!loginUsername.trim() || !loginPin) {
      setAuthError('Please enter username and PIN.');
      return;
    }

    try {
      if (isTauriRuntime) {
        const session = await window.__TAURI__!.core.invoke<SessionInfo>('auth_login', {
          payload: {
            username: loginUsername.trim(),
            pin: loginPin,
            branch_id: syncConfig?.branch_id || undefined,
            terminal_id: syncConfig?.terminal_id || undefined,
            counter_id: syncConfig?.counter_id || undefined,
          },
        });
        setCurrentSession(session);
        setLoginPin('');
        loadSessionData(session.token);
      } else {
        const isOwner = loginUsername.trim().toLowerCase() === 'owner' || loginUsername.toLowerCase().includes('admin');
        const role = isOwner ? 'ADMIN' : 'CASHIER';
        const todayStr = new Date().toISOString().substring(0, 10).replace(/-/g, '');
        const branchCode = syncConfig?.branch_id || 'IB';
        const simSession: SessionInfo = {
          token: `sim_${loginUsername}_token`,
          user_id: isOwner ? 'usr_owner_default' : 'usr_staff_default',
          username: loginUsername.trim().toLowerCase(),
          display_name: isOwner ? 'Store Owner' : 'Billing Staff',
          role,
          branch_id: branchCode,
          terminal_id: syncConfig?.terminal_id || 'T1',
          counter_id: syncConfig?.counter_id || 'C1',
          session_id: `sess_${branchCode}_${todayStr}_${loginUsername.trim().toLowerCase()}`,
          permissions: isOwner
            ? ['billing:finalize_sale', 'billing:reprint_receipt', 'users:manage', 'config:manage', 'reports:view']
            : ['billing:finalize_sale', 'billing:reprint_receipt'],
          expires_at: new Date(Date.now() + 28800000).toISOString(),
        };
        setCurrentSession(simSession);
      }
    } catch (err: any) {
      setAuthError(err.message || String(err));
    }
  };

  const handleLogout = async () => {
    if (currentSession && isTauriRuntime) {
      try {
        await window.__TAURI__!.core.invoke('auth_logout', { sessionToken: currentSession.token });
      } catch {}
    }
    setCurrentSession(null);
    setActiveTab('billing');
    setCartItems([]);
    setErrorMessage(null);
    setLoginPin('');
  };

  const handleCashierHandover = async (e: React.FormEvent) => {
    e.preventDefault();
    setSwitchError(null);
    if (!switchUsername.trim() || !switchPin) {
      setSwitchError('Please enter incoming cashier username and PIN.');
      return;
    }
    if (!currentSession) return;

    try {
      if (isTauriRuntime) {
        const newSession = await window.__TAURI__!.core.invoke<SessionInfo>('auth_switch_cashier', {
          payload: {
            active_token: currentSession.token,
            incoming_username: switchUsername.trim(),
            incoming_pin: switchPin,
          },
        });
        setCurrentSession(newSession);
        setIsSwitchModalOpen(false);
        setSwitchUsername('');
        setSwitchPin('');
        loadSessionData(newSession.token);
      } else {
        const simNew: SessionInfo = {
          token: `sim_${switchUsername}_token`,
          user_id: `usr_${switchUsername}`,
          username: switchUsername,
          display_name: switchUsername.toUpperCase(),
          role: 'CASHIER',
          branch_id: currentSession.branch_id,
          terminal_id: currentSession.terminal_id,
          counter_id: currentSession.counter_id,
          session_id: currentSession.session_id,
          permissions: ['billing:finalize_sale', 'billing:reprint_receipt'],
          expires_at: new Date(Date.now() + 28800000).toISOString(),
        };
        setCurrentSession(simNew);
        setIsSwitchModalOpen(false);
      }
    } catch (err: any) {
      setSwitchError(err.message || String(err));
    }
  };

  // --- Handlers: Admin User Management ---
  const loadAdminData = async () => {
    if (!currentSession || currentSession.role !== 'ADMIN' || !isTauriRuntime) return;
    try {
      const users = await window.__TAURI__!.core.invoke<UserRecord[]>('auth_list_users', { sessionToken: currentSession.token });
      setUserList(users);
      const logs = await window.__TAURI__!.core.invoke<AuditEventRecord[]>('auth_get_security_logs', { sessionToken: currentSession.token });
      setSecurityLogs(logs);
      await refreshCatalog(currentSession.token);
      await loadStockMovements(currentSession.token);
      await loadSyncStatus();
      await loadSyncConfig(currentSession.token);
    } catch (err: any) {
      setAdminActionError(err.message || String(err));
    }
  };

  const loadSyncStatus = async () => {
    if (!isTauriRuntime) return;
    try {
      const status = await window.__TAURI__!.core.invoke<SyncStatusState>('sync_get_status');
      setSyncStatus(status);
    } catch (e) {
      console.error('Failed to get sync status:', e);
    }
  };

  const loadSyncConfig = async (token?: string) => {
    if (!isTauriRuntime) return;
    try {
      const cfg = await window.__TAURI__!.core.invoke<BranchConfigState>('sync_get_branch_config', {
        sessionToken: token || currentSession?.token || null,
      });
      if (cfg) {
        if (!cfg.branch_name || cfg.branch_name.includes('Town Hall') || cfg.branch_name.includes('West Veli')) {
          cfg.branch_name = cfg.branch_id === 'UK' ? 'Umachikulam Branch (UK)' : 'Iyer Bungalow Branch (IB)';
        }
        setSyncConfig(cfg);
        setSyncConfigForm(cfg);
      }
    } catch (e) {
      console.error('Failed to get branch config:', e);
    }
  };

  const handleCheckForUpdates = async (silent: boolean = false) => {
    if (!isTauriRuntime) {
      if (!silent) {
        setUpdateErrorMessage(null);
        setUpdateStatusMessage(`In-app background updates are active on the Windows Desktop App (.exe). Current web preview version: v${currentAppVersion}`);
      }
      return;
    }

    try {
      setIsCheckingUpdate(true);
      if (!silent) {
        setUpdateErrorMessage(null);
        setUpdateStatusMessage('Checking GitHub Releases for new Malgudi POS updates...');
      }

      const update = await checkTauriUpdate();
      if (update) {
        setAvailableUpdate(update);
        setUpdateBannerDismissed(false);
        setUpdateStatusMessage(`✨ New version v${update.version} is available! (Current: v${currentAppVersion})`);
      } else {
        setAvailableUpdate(null);
        if (!silent) {
          setUpdateStatusMessage(`Malgudi POS is up to date (v${currentAppVersion}). No newer version found.`);
        }
      }
    } catch (err: any) {
      console.warn('Tauri update check failed:', err);
      if (!silent) {
        setUpdateErrorMessage(
          'Could not reach update server. Please verify internet connection. ' +
          (err?.message || String(err))
        );
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleApplyUpdate = async () => {
    if (!availableUpdate) return;
    try {
      setIsUpdating(true);
      setUpdateErrorMessage(null);
      setUpdateProgressPercent(0);
      setUpdateStatusMessage('Connecting to GitHub Releases and verifying cryptographic signature...');

      let downloaded = 0;
      let total = 0;

      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength || 0;
          setUpdateStatusMessage('Starting update download...');
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            const pct = Math.min(100, Math.round((downloaded / total) * 100));
            setUpdateProgressPercent(pct);
            setUpdateStatusMessage(
              `Downloading update: ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB)...`
            );
          } else {
            setUpdateStatusMessage(`Downloading update: ${(downloaded / 1024 / 1024).toFixed(1)} MB...`);
          }
        } else if (event.event === 'Finished') {
          setUpdateProgressPercent(100);
          setUpdateStatusMessage('Update downloaded and verified! Relaunching application...');
        }
      });

      // Relaunch the application with the new version
      await relaunch();
    } catch (err: any) {
      console.error('Update installation failed:', err);
      setIsUpdating(false);
      setUpdateErrorMessage('Update installation failed: ' + (err?.message || String(err)));
    }
  };

  const handleTriggerSync = async () => {
    if (!isTauriRuntime || isSyncing) return;
    setIsSyncing(true);
    setSyncMessage(null);
    try {
      const res = await window.__TAURI__!.core.invoke<any>('sync_trigger_bidirectional', {
        sessionToken: currentSession?.token,
      });
      await loadSyncStatus();
      await refreshCatalog(currentSession?.token, currentSession?.branch_id);
      setSyncMessage(res.message);
    } catch (err: any) {
      setSyncMessage('Sync failed: ' + (err.message || String(err)));
      await loadSyncStatus();
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveBranchConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession || currentSession.role !== 'ADMIN') return;
    setAdminActionMessage(null);
    setAdminActionError(null);
    setIsSavingBranchConfig(true);
    setBranchConfigSavedSuccess(false);
    try {
      if (isTauriRuntime) {
        await window.__TAURI__!.core.invoke('sync_set_branch_config', {
          sessionToken: currentSession.token,
          config: syncConfigForm,
        });
      }
      // Tactical UX hold (450ms) to ensure smooth human-perceptible blur and loading indication
      await new Promise(resolve => setTimeout(resolve, 450));
      setAdminActionMessage(`Branch configuration saved successfully! Active Identity: ${syncConfigForm.branch_id} - ${syncConfigForm.branch_name}`);
      await loadSyncConfig();
      await loadSyncStatus();
      setBranchConfigSavedSuccess(true);
      setTimeout(() => setBranchConfigSavedSuccess(false), 3500);
    } catch (err: any) {
      setAdminActionError('Failed to save branch config: ' + (err.message || String(err)));
    } finally {
      setIsSavingBranchConfig(false);
    }
  };

  const handleCreateCashier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession) return;
    setAdminActionMessage(null);
    setAdminActionError(null);
    try {
      if (isTauriRuntime) {
        const user = await window.__TAURI__!.core.invoke<UserRecord>('auth_create_user', {
          sessionToken: currentSession.token,
          payload: {
            username: newCashierUsername.trim(),
            display_name: newCashierDisplayName.trim(),
            role: newCashierRole,
            pin: newCashierPin,
          },
        });
        setAdminActionMessage(`User '${user.username}' created successfully.`);
        setNewCashierUsername('');
        setNewCashierDisplayName('');
        setNewCashierPin('');
        loadAdminData();
      }
    } catch (err: any) {
      setAdminActionError(err.message || String(err));
    }
  };

  const handleToggleUserStatus = async (user: UserRecord) => {
    if (!currentSession) return;
    const targetStatus = user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    setAdminActionMessage(null);
    setAdminActionError(null);
    try {
      if (isTauriRuntime) {
        await window.__TAURI__!.core.invoke('auth_update_user_status', {
          sessionToken: currentSession.token,
          userId: user.id,
          status: targetStatus,
        });
        setAdminActionMessage(`User '${user.username}' status updated to ${targetStatus}.`);
        loadAdminData();
      }
    } catch (err: any) {
      setAdminActionError(err.message || String(err));
    }
  };

  const handleDeleteUser = async (user: UserRecord) => {
    if (!currentSession) return;
    if (!window.confirm(`Are you sure you want to permanently delete user '${user.username}' (${user.display_name})?`)) {
      return;
    }
    setAdminActionMessage(null);
    setAdminActionError(null);
    try {
      if (isTauriRuntime) {
        await window.__TAURI__!.core.invoke('auth_delete_user', {
          sessionToken: currentSession.token,
          userId: user.id,
        });
        setAdminActionMessage(`User '${user.username}' permanently deleted.`);
        loadAdminData();
      }
    } catch (err: any) {
      setAdminActionError(err.message || String(err));
    }
  };

  const handleExecutePinReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPinUserId || resetPinValue.length < 4 || !currentSession) return;
    setAdminActionMessage(null);
    setAdminActionError(null);
    try {
      if (isTauriRuntime) {
        await window.__TAURI__!.core.invoke('auth_reset_user_pin', {
          sessionToken: currentSession.token,
          userId: resetPinUserId,
          newPin: resetPinValue,
        });
        setAdminActionMessage('User PIN reset successfully.');
        setResetPinUserId(null);
        setResetPinValue('');
        loadAdminData();
      }
    } catch (err: any) {
      setAdminActionError(err.message || String(err));
    }
  };

  const handleTriggerBackup = async () => {
    if (!currentSession || !isTauriRuntime) return;
    setAdminActionMessage(null);
    setAdminActionError(null);
    try {
      const dest = await window.__TAURI__!.core.invoke<string>('create_backup', { sessionToken: currentSession.token });
      setAdminActionMessage(`Backup successfully created at: ${dest}`);
    } catch (err: any) {
      setAdminActionError('Backup failed: ' + (err.message || String(err)));
    }
  };

  // --- Handlers: Product Management & Stock Operations ---
  const refreshCatalog = async (_token?: string, branch?: string) => {
    if (!isTauriRuntime) return;
    setCatalogLoading(true);
    try {
      const items = await window.__TAURI__!.core.invoke<DBProductRecord[]>('inventory_list_products', {
        branchId: branch || currentSession?.branch_id || 'IB',
        includeInactive: currentSession?.role === 'ADMIN',
      });
      if (items && items.length > 0) {
        setCatalog(items);
      }
    } catch (err) {
      console.error('Failed to load products from database:', err);
    } finally {
      setCatalogLoading(false);
    }
  };

  const loadStockMovements = async (token?: string, productId?: string) => {
    const activeToken = token || currentSession?.token;
    if (!isTauriRuntime || !activeToken || currentSession?.role !== 'ADMIN') return;
    try {
      const movements = await window.__TAURI__!.core.invoke<StockMovementRecord[]>('inventory_list_movements', {
        sessionToken: activeToken,
        productId: productId || null,
        branchId: currentSession?.branch_id || 'IB',
        limit: 100,
      });
      setStockMovements(movements || []);
    } catch (err: any) {
      console.error('Failed to load stock movements:', err);
    }
  };

  const handleAddCategory = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCatName.trim()) return;
    const catId = `cat_${newCatName.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now().toString().slice(-4)}`;
    const derivedPrefix = (
      newCatSkuPrefix.trim() ||
      newCatName.replace(/[^a-zA-Z]/g, '').slice(0, 3) ||
      'ITM'
    ).toUpperCase();
    const newCat: CatalogCategory = {
      id: catId,
      name: newCatName.trim(),
      tamil_name: newCatTamilName.trim() || newCatName.trim(),
      icon: newCatIcon.trim() || '📦',
      sku_prefix: derivedPrefix,
    };
    const updated = [...categories, newCat];
    setCategories(updated);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('pos_custom_categories', JSON.stringify(updated));
      } catch {}
    }
    setNewCatName('');
    setNewCatTamilName('');
    setNewCatIcon('📦');
    setNewCatSkuPrefix('');
    setIsAddCategoryModalOpen(false);
    setAdminActionMessage(`New category "${newCat.name}" (Prefix: ${derivedPrefix}) added successfully.`);
    setTimeout(() => setAdminActionMessage(null), 4000);
  };

  const handleOpenAddProduct = () => {
    setEditingProduct(null);
    setProdFormName('');
    setProdFormTamilName('');
    setProdFormSku(generateNextSku('cat_sweets', catalog, categories));
    setProdFormBarcode('');
    setProdFormCategory('cat_sweets');
    setProdFormPricingUnit('PER_KG');
    setProdFormInventoryUnit('MG');
    setProdFormPriceRupees('500');
    setProdFormGstPercent(5);
    setProdFormHsn('21069099');
    setProdFormInitialStock('25');
    setProdFormError(null);
    setIsProductModalOpen(true);
  };

  const handleOpenEditProduct = (prod: DBProductRecord) => {
    setEditingProduct(prod);
    setProdFormName(prod.name);
    setProdFormTamilName(prod.tamil_name);
    setProdFormSku(prod.sku);
    setProdFormBarcode(prod.barcode || '');
    setProdFormCategory(prod.category_id);
    setProdFormPricingUnit(prod.pricing_unit);
    setProdFormInventoryUnit(prod.inventory_unit);
    setProdFormPriceRupees((prod.base_price_paise / 100).toString());
    setProdFormGstPercent(prod.tax_rate_bps / 100);
    setProdFormHsn(prod.hsn_code);
    setProdFormError(null);
    setIsProductModalOpen(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession) return;
    setProdFormError(null);

    const priceRupees = parseFloat(prodFormPriceRupees);
    if (isNaN(priceRupees) || priceRupees <= 0) {
      setProdFormError('Please enter a valid base selling price greater than 0.');
      return;
    }

    try {
      if (isTauriRuntime) {
        if (editingProduct) {
          await window.__TAURI__!.core.invoke('inventory_update_product', {
            sessionToken: currentSession.token,
            payload: {
              id: editingProduct.id,
              name: prodFormName.trim(),
              tamil_name: prodFormTamilName.trim(),
              sku: prodFormSku.trim().toUpperCase(),
              barcode: prodFormBarcode.trim() || null,
              category_id: prodFormCategory,
              pricing_unit: prodFormPricingUnit,
              inventory_unit: prodFormInventoryUnit,
              base_price_paise: Math.round(priceRupees * 100),
              piece_price_paise: null,
              tax_rate_bps: Math.round(prodFormGstPercent * 100),
              hsn_code: prodFormHsn.trim(),
              is_active: editingProduct.is_active,
            },
          });
          setAdminActionMessage(`Product '${prodFormName}' updated successfully.`);
        } else {
          let initialQtyCanonical = 0;
          if (prodFormInitialStock) {
            const rawInit = parseFloat(prodFormInitialStock);
            if (!isNaN(rawInit) && rawInit > 0) {
              initialQtyCanonical = prodFormPricingUnit === 'PER_KG' ? Math.round(rawInit * 1000000) : Math.round(rawInit);
            }
          }

          await window.__TAURI__!.core.invoke('inventory_create_product', {
            sessionToken: currentSession.token,
            payload: {
              name: prodFormName.trim(),
              tamil_name: prodFormTamilName.trim(),
              sku: prodFormSku.trim().toUpperCase(),
              barcode: prodFormBarcode.trim() || null,
              category_id: prodFormCategory,
              pricing_unit: prodFormPricingUnit,
              inventory_unit: prodFormInventoryUnit,
              base_price_paise: Math.round(priceRupees * 100),
              piece_price_paise: null,
              tax_rate_bps: Math.round(prodFormGstPercent * 100),
              hsn_code: prodFormHsn.trim(),
              initial_stock: initialQtyCanonical > 0 ? initialQtyCanonical : null,
              branch_id: currentSession.branch_id || 'IB',
            },
          });
          setAdminActionMessage(`Product '${prodFormName}' created successfully.`);
        }
        setIsProductModalOpen(false);
        await refreshCatalog(currentSession.token);
      }
    } catch (err: any) {
      setProdFormError(err.message || String(err));
    }
  };

  const handleToggleProductStatus = async (prod: DBProductRecord) => {
    if (!currentSession) return;
    try {
      if (isTauriRuntime) {
        await window.__TAURI__!.core.invoke('inventory_toggle_product_status', {
          sessionToken: currentSession.token,
          productId: prod.id,
          isActive: !prod.is_active,
        });
        setAdminActionMessage(`Product '${prod.name}' ${prod.is_active ? 'deactivated' : 'activated'}.`);
        await refreshCatalog(currentSession.token);
      }
    } catch (err: any) {
      setAdminActionError(err.message || String(err));
    }
  };

  const handleOpenStockAdjust = (productId?: string) => {
    setAdjustProductId(productId || (catalog[0]?.id || ''));
    setAdjustMovementType('RECEIPT_PRODUCTION');
    setAdjustQuantity('10');
    setAdjustReason('');
    setAdjustReferenceId('');
    setAdjustError(null);
    setIsStockAdjustModalOpen(true);
  };

  const handleAdjustStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession) return;
    setAdjustError(null);

    if (!adjustReason.trim()) {
      setAdjustError('MANDATORY_FIELD: Reason is strictly required for stock audit history.');
      return;
    }

    const targetProduct = catalog.find(p => p.id === adjustProductId);
    if (!targetProduct) {
      setAdjustError('Selected product not found.');
      return;
    }

    const rawQty = parseFloat(adjustQuantity);
    if (isNaN(rawQty) || rawQty <= 0) {
      setAdjustError('Please enter a valid quantity greater than 0.');
      return;
    }

    const qtyDelta = targetProduct.pricing_unit === 'PER_KG' ? Math.round(rawQty * 1000000) : Math.round(rawQty);

    try {
      if (isTauriRuntime) {
        await window.__TAURI__!.core.invoke('inventory_adjust_stock', {
          sessionToken: currentSession.token,
          payload: {
            branch_id: currentSession.branch_id || 'IB',
            product_id: adjustProductId,
            movement_type: adjustMovementType,
            quantity_delta: qtyDelta,
            unit: targetProduct.inventory_unit,
            reason: adjustReason.trim(),
            reference_id: adjustReferenceId.trim() || null,
          },
        });
        setAdminActionMessage(`Stock adjusted successfully for '${targetProduct.name}'.`);
        setIsStockAdjustModalOpen(false);
        await refreshCatalog(currentSession.token);
        await loadStockMovements(currentSession.token);
      }
    } catch (err: any) {
      setAdjustError(err.message || String(err));
    }
  };

  const handleVoidSaleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentSession || !voidTargetSale) return;
    setVoidError(null);

    if (!voidReason.trim()) {
      setVoidError('MANDATORY_FIELD: Reason is required to cancel or void a bill.');
      return;
    }

    try {
      if (isTauriRuntime) {
        await window.__TAURI__!.core.invoke('inventory_void_sale', {
          sessionToken: currentSession.token,
          payload: {
            sale_id: voidTargetSale.sale_id,
            reason: voidReason.trim(),
          },
        });

        setPersistedHistory(prev =>
          prev.map(s => (s.sale_id === voidTargetSale.sale_id ? { ...s, sale_status: 'VOIDED', payment_status: 'REFUNDED' } : s))
        );

        setAdminActionMessage(`Invoice '${voidTargetSale.invoice_number}' voided successfully. Stock restored to inventory.`);
        setVoidTargetSale(null);
        setVoidReason('');
        await refreshCatalog(currentSession.token);
        await loadStockMovements(currentSession.token);
      }
    } catch (err: any) {
      setVoidError(err.message || String(err));
    }
  };

  // --- Handlers: Sales & GST Financial Reports ---
  const loadReports = async (start = reportStartDate, end = reportEndDate) => {
    if (!currentSession || currentSession.role !== 'ADMIN' || !isTauriRuntime) return;
    setReportsLoading(true);
    setReportsError(null);
    try {
      const data = await window.__TAURI__!.core.invoke<FinancialReportsAggregate>('reports_get_financial_reports', {
        sessionToken: currentSession.token,
        filter: {
          start_date: start || null,
          end_date: end || null,
          branch_id: currentSession.branch_id || 'IB',
        },
      });
      setReportsData(data);
    } catch (err: any) {
      setReportsError(err.message || String(err));
    } finally {
      setReportsLoading(false);
    }
  };

  const handleSetDatePreset = (preset: 'today' | 'yesterday' | 'this_month' | 'last_30_days') => {
    const today = new Date();
    const toDateStr = (d: Date) => d.toISOString().split('T')[0];

    if (preset === 'today') {
      const t = toDateStr(today);
      setReportStartDate(t);
      setReportEndDate(t);
      loadReports(t, t);
    } else if (preset === 'yesterday') {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const yStr = toDateStr(y);
      setReportStartDate(yStr);
      setReportEndDate(yStr);
      loadReports(yStr, yStr);
    } else if (preset === 'this_month') {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      const s = toDateStr(firstDay);
      const e = toDateStr(today);
      setReportStartDate(s);
      setReportEndDate(e);
      loadReports(s, e);
    } else if (preset === 'last_30_days') {
      const past30 = new Date(today);
      past30.setDate(past30.getDate() - 30);
      const s = toDateStr(past30);
      const e = toDateStr(today);
      setReportStartDate(s);
      setReportEndDate(e);
      loadReports(s, e);
    }
  };

  const exportCsv = async (filename: string, headers: string[], rows: (string | number)[][]) => {
    const csvContent = [
      headers.join(','),
      ...rows.map(row =>
        row
          .map(val => {
            const str = String(val ?? '');
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          })
          .join(',')
      ),
    ].join('\n');

    const cleanFilename = `${filename}_${reportStartDate}_to_${reportEndDate}.csv`;

    if (isTauriRuntime) {
      try {
        const savedPath = await window.__TAURI__!.core.invoke<string>('export_save_csv_file', {
          filename: cleanFilename,
          csvContent,
        });
        setAdminActionMessage(`✅ Exported to Excel/CSV! Saved to: ${savedPath}`);
        setTimeout(() => setAdminActionMessage(null), 8000);
        return;
      } catch (err: any) {
        console.error('Tauri CSV export error, falling back to browser download:', err);
        setAdminActionError(`CSV Export error: ${err.message || String(err)}`);
      }
    }

    // Web download fallback with UTF-8 BOM so Excel opens characters properly
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', cleanFilename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setAdminActionMessage(`✅ Exported ${cleanFilename}`);
    setTimeout(() => setAdminActionMessage(null), 5000);
  };

  const handleExportCurrentReportCsv = () => {
    if (!reportsData) return;

    if (activeReportView === 'daily') {
      const headers = [
        'Business Date',
        'Total Bills Recorded',
        'Active Bills',
        'Voided Bills',
        'Taxable Sales (INR)',
        'Total GST (INR)',
        'Gross Sales (INR)',
        'Voided Amount (INR)',
        'Net Sales (INR)',
      ];
      const rows = reportsData.daily_sales.daily_breakdown.map(r => [
        r.business_date,
        r.total_bills,
        r.active_bills,
        r.voided_bills,
        (r.taxable_sales_paise / 100).toFixed(2),
        (r.total_tax_paise / 100).toFixed(2),
        (r.gross_sales_paise / 100).toFixed(2),
        (r.voided_amount_paise / 100).toFixed(2),
        (r.net_sales_paise / 100).toFixed(2),
      ]);
      exportCsv('daily_sales_report', headers, rows);
    } else if (activeReportView === 'payments') {
      const headers = [
        'Payment Method',
        'Active Bills Count',
        'Gross Collected (INR)',
        'Refunds (INR)',
        'Net Collected (INR)',
      ];
      const rows = reportsData.payment_summary.methods_breakdown.map(m => [
        m.payment_method,
        m.bills_count,
        (m.total_collected_paise / 100).toFixed(2),
        (m.refunds_paise / 100).toFixed(2),
        (m.net_amount_paise / 100).toFixed(2),
      ]);
      exportCsv('payment_summary_report', headers, rows);
    } else if (activeReportView === 'gst') {
      const headers = [
        'Invoice Number',
        'Business Date',
        'Status',
        'HSN Codes',
        'Taxable Value (INR)',
        'CGST (INR)',
        'SGST (INR)',
        'Total GST (INR)',
        'Round Off (INR)',
        'Net Payable (INR)',
      ];
      const rows = reportsData.gst_report.invoice_details.map(inv => [
        inv.invoice_number,
        inv.business_date,
        inv.sale_status,
        inv.hsn_summary,
        (inv.taxable_paise / 100).toFixed(2),
        (inv.cgst_paise / 100).toFixed(2),
        (inv.sgst_paise / 100).toFixed(2),
        (inv.total_tax_paise / 100).toFixed(2),
        (inv.round_off_paise / 100).toFixed(2),
        (inv.net_payable_paise / 100).toFixed(2),
      ]);
      exportCsv('gst_invoices_report', headers, rows);
    } else if (activeReportView === 'products') {
      const headers = [
        'SKU',
        'Product Name',
        'Tamil Name',
        'Category',
        'Pricing Unit',
        'Quantity Sold',
        'Bills Count',
        'Taxable Revenue (INR)',
        'GST (INR)',
        'Gross Revenue (INR)',
        'Revenue Share (%)',
      ];
      const rows = reportsData.product_sales.products.map(p => [
        p.sku,
        p.product_name,
        p.tamil_name,
        p.category_id,
        p.pricing_unit,
        p.quantity_formatted,
        p.bills_count,
        (p.taxable_paise / 100).toFixed(2),
        (p.tax_paise / 100).toFixed(2),
        (p.gross_paise / 100).toFixed(2),
        p.revenue_share_percent,
      ]);
      exportCsv('product_sales_report', headers, rows);
    } else if (activeReportView === 'drawer') {
      const headers = ['Timestamp', 'Movement Type', 'Direction', 'Reference ID', 'Amount (INR)', 'Session ID'];
      const rows = reportsData.cash_drawer.movements.map(m => [
        m.created_at,
        m.movement_type,
        m.direction,
        m.reference_id,
        (m.amount_paise / 100).toFixed(2),
        m.session_id,
      ]);
      exportCsv('cash_drawer_report', headers, rows);
    }
  };

  // --- Handlers: Product Catalog & Cart Operations ---
  const filteredProducts = useMemo(() => {
    // Only display active products in the cashier catalog
    let list = catalog.filter(p => p.is_active);
    if (selectedCategory !== 'all') {
      list = list.filter(p => p.category_id === selectedCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        p =>
          p.name.toLowerCase().includes(q) ||
          p.tamil_name.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q)
      );
    }
    return list;
  }, [catalog, searchQuery, selectedCategory]);

  const handleProductCardClick = (product: DBProductRecord) => {
    if (product.pricing_unit === 'PER_KG') {
      // Fast 1-tap addition of 250g standard sweet box — directly to cart, NO POPUP!
      addItemWithQuantity(product, 250, 'MANUAL_KEYPAD');
    } else {
      // Piece / pack items: fast 1-tap addition
      addItemWithQuantity(product, 1, 'MANUAL_KEYPAD');
    }
  };

  const handleOpenItemEditModal = (idx: number, item: SaleItemAllocation, prod?: DBProductRecord) => {
    const productRecord = prod || catalog.find(p => p.id === item.product_id);
    if (!productRecord) return;
    setWeightModalProduct(productRecord);
    setWeightModalCartIndex(idx);
    if (productRecord.pricing_unit === 'PER_KG') {
      const g = Math.round(item.quantity_input / 1000);
      setWeightModalGrams(g);
      setWeightModalKgInput((g / 1000).toString());
      setWeightModalUnit('g');
    } else {
      setWeightModalGrams(item.quantity_input);
      setWeightModalKgInput(item.quantity_input.toString());
      setWeightModalUnit('pc');
    }
  };

  const addItemWithQuantity = (product: DBProductRecord, quantityInput: number, weightSource: WeightInputSource) => {
    try {
      const prodDef = toProductDefinition(product);
      const existingIdx = cartItems.findIndex(i => i.product_id === product.id);
      const addDelta = product.pricing_unit === 'PER_KG' ? quantityInput * 1000 : quantityInput;
      if (existingIdx >= 0) {
        // Increment quantity in cart (250g for weight items, 1 for unit items)
        const updatedQty = cartItems[existingIdx].quantity_input + addDelta;
        const updatedItem = calculateLineItem({
          product: prodDef,
          quantityInput: updatedQty,
          weightInputSource: weightSource,
        });
        setCartItems(prev => {
          const next = [...prev];
          next[existingIdx] = updatedItem;
          return next;
        });
      } else {
        const newItem = calculateLineItem({
          product: prodDef,
          quantityInput: addDelta,
          weightInputSource: weightSource,
        });
        setCartItems(prev => [...prev, newItem]);
      }
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to add item to cart');
    }
  };

  const handleWeightModalSubmit = () => {
    if (!weightModalProduct || weightModalGrams <= 0) return;
    try {
      const qtyInput = weightModalProduct.pricing_unit === 'PER_KG'
        ? Math.round(weightModalGrams * 1000)
        : weightModalGrams;

      const newItem = calculateLineItem({
        product: toProductDefinition(weightModalProduct),
        quantityInput: qtyInput,
        weightInputSource: 'MANUAL_KEYPAD',
      });
      if (weightModalCartIndex !== null && weightModalCartIndex >= 0) {
        setCartItems(prev => {
          const next = [...prev];
          next[weightModalCartIndex] = newItem;
          return next;
        });
      } else {
        const existingIdx = cartItems.findIndex(i => i.product_id === weightModalProduct.id);
        if (existingIdx >= 0) {
          setCartItems(prev => {
            const next = [...prev];
            next[existingIdx] = newItem;
            return next;
          });
        } else {
          setCartItems(prev => [...prev, newItem]);
        }
      }
      setWeightModalProduct(null);
      setWeightModalCartIndex(null);
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to calculate line item');
    }
  };

  const handleAdjustCartItemQty = (index: number, delta: number) => {
    const item = cartItems[index];
    const product = catalog.find(p => p.id === item.product_id);
    if (!product) return;

    try {
      const prodDef = toProductDefinition(product);
      if (item.pricing_unit === 'PER_KG') {
        // Adjust weight by 50g
        const currentGrams = Math.round(item.quantity_input / 1000);
        const newGrams = currentGrams + delta * 50;
        if (newGrams <= 0) {
          handleRemoveCartItem(index);
          return;
        }
        const updated = calculateLineItem({
          product: prodDef,
          quantityInput: newGrams * 1000,
          weightInputSource: item.weight_input_source,
        });
        setCartItems(prev => prev.map((it, idx) => (idx === index ? updated : it)));
      } else {
        // Adjust piece count by 1
        const newCount = item.quantity_input + delta;
        if (newCount <= 0) {
          handleRemoveCartItem(index);
          return;
        }
        const updated = calculateLineItem({
          product: prodDef,
          quantityInput: newCount,
          weightInputSource: item.weight_input_source,
        });
        setCartItems(prev => prev.map((it, idx) => (idx === index ? updated : it)));
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error updating quantity');
    }
  };

  const handleDirectWeightChange = (index: number, grams: number) => {
    const item = cartItems[index];
    const product = catalog.find(p => p.id === item.product_id);
    if (!product) return;

    try {
      if (grams <= 0) {
        handleRemoveCartItem(index);
        return;
      }
      const updated = calculateLineItem({
        product: toProductDefinition(product),
        quantityInput: Math.round(grams * 1000),
        weightInputSource: 'MANUAL_KEYPAD',
      });
      setCartItems(prev => prev.map((it, idx) => (idx === index ? updated : it)));
      setErrorMessage(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error updating weight');
    }
  };

  const handleRemoveCartItem = (index: number) => {
    setCartItems(prev => prev.filter((_, i) => i !== index));
  };

  const handleClearCart = () => {
    if (cartItems.length === 0) return;
    setCartItems([]);
  };

  // --- Handlers: Payment & Finalize Sale ---
  const handleFinalizeSale = async (override?: {
    cashTendered?: number;
    cashAllocated?: number;
    upiAllocated?: number;
    upiVerificationSource?: PaymentVerificationSource;
  }) => {
    if (isFinalizing) return;
    setErrorMessage(null);
    setIsFinalizing(true);

    try {
      if (cartItems.length === 0) {
        throw new Error('Cart is empty. Add at least one item before checkout.');
      }
      if (!currentSession) {
        throw new Error('UNAUTHENTICATED: No active cashier session. Please log in.');
      }

      const totalPaise = totalGrossPaise;
      const payments: PaymentTenderAllocation[] = [];

      let activeUpiSource = override?.upiVerificationSource || upiVerificationSource;

      // 1. Determine UPI allocation in paise
      let activeUpiAllocatedPaise = 0;
      if (override?.upiAllocated !== undefined) {
        activeUpiAllocatedPaise = Math.round(override.upiAllocated * 100);
      } else if (upiAllocatedRupees > 0) {
        activeUpiAllocatedPaise = Math.round(upiAllocatedRupees * 100);
      }

      // If UPI covers full bill amount
      if (activeUpiAllocatedPaise >= totalPaise || (override?.upiAllocated !== undefined && override.cashAllocated === 0)) {
        activeUpiAllocatedPaise = totalPaise;
      }

      // 2. Determine Cash allocation in paise
      let activeCashAllocatedPaise = 0;
      if (activeUpiAllocatedPaise >= totalPaise) {
        activeCashAllocatedPaise = 0;
      } else if (activeUpiAllocatedPaise === 0) {
        // Pure cash sale: guarantees 100% exact paise allocation
        activeCashAllocatedPaise = totalPaise;
      } else {
        // Split sale: cash absorbs remainder to guarantee exact balance
        activeCashAllocatedPaise = Math.max(0, totalPaise - activeUpiAllocatedPaise);
      }

      // 3. Determine Cash tendered and change returned in paise
      let rawTendered = override?.cashTendered !== undefined ? override.cashTendered : cashTenderedRupees;
      let activeCashTenderedPaise = activeCashAllocatedPaise > 0
        ? Math.max(Math.round(rawTendered * 100), activeCashAllocatedPaise)
        : 0;

      const activeChangePaise = Math.max(0, activeCashTenderedPaise - activeCashAllocatedPaise);

      if (activeCashAllocatedPaise > 0) {
        payments.push({
          id: `pay_cash_${Date.now()}`,
          payment_method: 'CASH',
          allocated_amount_paise: activeCashAllocatedPaise,
          tendered_paise: activeCashTenderedPaise,
          change_returned_paise: activeChangePaise,
          net_amount_paise: activeCashAllocatedPaise,
          outcome: 'SUCCESS',
          verification_source: 'PHYSICAL_CASH_DRAWER',
        });
      }

      if (activeUpiAllocatedPaise > 0) {
        const isGatewayConfirmed = activeUpiSource === 'GATEWAY_API';
        payments.push({
          id: `pay_upi_${Date.now()}`,
          payment_method: isGatewayConfirmed ? 'UPI_GATEWAY_DYNAMIC' : 'UPI_MANUAL_RECORDED',
          allocated_amount_paise: activeUpiAllocatedPaise,
          tendered_paise: activeUpiAllocatedPaise,
          change_returned_paise: 0,
          net_amount_paise: activeUpiAllocatedPaise,
          outcome: 'SUCCESS',
          verification_source: activeUpiSource,
          is_gateway_confirmed: isGatewayConfirmed,
          reference_note: activeUpiSource === 'GATEWAY_API' ? 'Dynamic QR Webhook Confirmed' : 'Soundbox Audio Confirmed',
          verified_by_user_id: currentSession.user_id,
        });
      }

      const tenderValidation = validateAndReconcileSplitTender(totalPaise, payments);
      if (!tenderValidation.isValid) {
        throw new Error(`Split Tender Error: ${tenderValidation.errors.join('; ')}`);
      }

      const lifecycleEval = evaluateTransactionPaymentLifecycle(totalPaise, payments, settlementPolicy);
      if (settlementPolicy === 'STRICT_GATEWAY_ONLY' && !lifecycleEval.canFinalizeAndCommit) {
        throw new Error(`Settlement Blocked: ${lifecycleEval.errors.join('; ')}`);
      }

      const businessDate = new Date().toISOString().split('T')[0];
      const financialYearCode = getIndianFinancialYearCode(businessDate);
      const seriesCode = `${currentSession.branch_id}1`;

      const payload = {
        branch_id: currentSession.branch_id,
        counter_id: currentSession.counter_id,
        terminal_id: currentSession.terminal_id,
        session_id: currentSession.session_id,
        business_date: businessDate,
        series_code: seriesCode,
        financial_year: financialYearCode,
        tax_policy_version: '2026.1-TN',
        subtotal_taxable_paise: subtotalTaxablePaise,
        total_cgst_paise: totalCgstPaise,
        total_sgst_paise: totalSgstPaise,
        total_igst_paise: 0,
        round_off_paise: 0,
        net_payable_paise: totalGrossPaise,
        items: cartItems.map(item => ({
          product_id: item.product_id,
          quantity_input: item.quantity_input,
          pricing_unit: item.pricing_unit,
          weight_input_source: item.weight_input_source,
          unit_price_paise: item.unit_price_paise,
          taxable_paise: item.taxable_paise,
          cgst_paise: item.cgst_paise,
          sgst_paise: item.sgst_paise,
          igst_paise: item.igst_paise,
          total_tax_paise: item.total_tax_paise,
          gross_paise: item.gross_paise,
          stock_deduction_delta: item.stock_deduction_delta,
          stock_unit: item.stock_unit || 'MG',
        })),
        payments: payments.map(p => ({
          payment_method: p.payment_method,
          allocated_amount_paise: p.allocated_amount_paise,
          tendered_paise: p.tendered_paise,
          change_returned_paise: p.change_returned_paise,
          net_amount_paise: p.net_amount_paise,
          outcome: p.outcome,
          reference_note: p.reference_note || null,
          verified_by_user_id: p.verified_by_user_id || null,
        })),
        cashier_id: currentSession.user_id,
        customer_name: customerInfo?.name?.trim() || null,
        customer_phone: customerInfo?.phone?.trim() || null,
        customer_location: customerInfo?.location?.trim() || null,
      };

      let committedRecord: FinalizeSaleResult;

      if (isTauriRuntime) {
        const rawResult = await window.__TAURI__!.core.invoke<any>('finalize_sale', {
          sessionToken: currentSession.token,
          payload,
        });

        committedRecord = {
          sale_id: rawResult.sale_id,
          invoice_number: rawResult.invoice_number,
          event_id: rawResult.event_id,
          payload_hash: rawResult.payload_hash,
          items_count: cartItems.length,
          net_payable_paise: totalGrossPaise,
          cash_retained_paise: activeCashAllocatedPaise,
          upi_settled_paise: activeUpiAllocatedPaise,
          sale_status: 'COMPLETED',
          payment_status: lifecycleEval.derivedPaymentStatus,
          created_at: new Date().toISOString(),
        };
      } else {
        const nextSeq = persistedHistory.length + 101;
        committedRecord = {
          sale_id: `dev_sim_${Date.now()}`,
          invoice_number: `${seriesCode}/${financialYearCode}/${String(nextSeq).padStart(6, '0')} [SIM]`,
          event_id: `evt_dev_${Date.now()}`,
          payload_hash: `sha256_${Date.now()}`,
          items_count: cartItems.length,
          net_payable_paise: totalGrossPaise,
          cash_retained_paise: activeCashAllocatedPaise,
          upi_settled_paise: activeUpiAllocatedPaise,
          sale_status: 'COMPLETED',
          payment_status: lifecycleEval.derivedPaymentStatus,
          created_at: new Date().toISOString(),
        };
      }

      const detailedItems: DetailedReceiptItem[] = cartItems.map(item => {
        const prod = catalog.find(p => p.id === item.product_id);
        const qtyInput = item.pricing_unit === 'PER_KG' ? Math.round(item.quantity_input / 1000) : item.quantity_input;
        const qtyFormatted = item.pricing_unit === 'PER_KG'
          ? (qtyInput >= 1000 ? `${(qtyInput / 1000).toFixed(3)} kg` : `${qtyInput}g`)
          : `${qtyInput} pcs`;

        return {
          product_id: item.product_id,
          product_name: prod ? prod.name : item.product_id,
          tamil_name: prod ? prod.tamil_name : '',
          pricing_unit: item.pricing_unit,
          quantity_input: qtyInput,
          quantity_formatted: qtyFormatted,
          unit_price_paise: prod ? prod.base_price_paise : 0,
          taxable_paise: item.taxable_paise,
          cgst_paise: item.cgst_paise,
          sgst_paise: item.sgst_paise,
          total_tax_paise: item.total_tax_paise,
          gross_paise: item.gross_paise,
        };
      });

      const detailedPayments: DetailedReceiptPayment[] = [];
      if (activeCashAllocatedPaise > 0) {
        detailedPayments.push({
          payment_method: 'CASH',
          allocated_amount_paise: activeCashAllocatedPaise,
          tendered_paise: activeCashTenderedPaise,
          change_returned_paise: activeChangePaise,
          net_amount_paise: activeCashAllocatedPaise,
        });
      }
      if (activeUpiAllocatedPaise > 0) {
        detailedPayments.push({
          payment_method: 'UPI',
          allocated_amount_paise: activeUpiAllocatedPaise,
          tendered_paise: activeUpiAllocatedPaise,
          change_returned_paise: 0,
          net_amount_paise: activeUpiAllocatedPaise,
        });
      }

      const detailedReceipt: DetailedSaleReceipt = {
        sale_id: committedRecord.sale_id,
        invoice_number: committedRecord.invoice_number,
        business_date: new Date().toISOString().substring(0, 10),
        created_at: committedRecord.created_at,
        cashier_name: currentSession.display_name,
        terminal_id: currentSession.terminal_id,
        branch_id: currentSession.branch_id,
        branch_name: syncConfig?.branch_name || 'Iyer Bungalow Branch (IB)',
        subtotal_taxable_paise: subtotalTaxablePaise,
        total_cgst_paise: totalCgstPaise,
        total_sgst_paise: totalSgstPaise,
        round_off_paise: 0,
        net_payable_paise: totalGrossPaise,
        sale_status: committedRecord.sale_status || 'COMPLETED',
        payment_status: committedRecord.payment_status || 'SETTLED',
        items: detailedItems,
        payments: detailedPayments,
        customer_name: customerInfo?.name?.trim() || null,
        customer_phone: customerInfo?.phone?.trim() || null,
        customer_location: customerInfo?.location?.trim() || null,
      };

      setPersistedHistory(prev => [committedRecord, ...prev]);
      setActiveReceiptModal(detailedReceipt);
      setIsPaymentModalOpen(false);
      setIsUpiModalOpen(false);
      setUpiSimulatedVerified(false);
      setCartItems([]);
      setCustomerInfo(null);
      setCustomerForm({ name: '', phone: '', location: '' });
      setCashTenderedRupees(0);
      setUpiAllocatedRupees(0);
      refreshCatalog(currentSession?.token);
      loadSyncStatus();
      loadLiveDrawerSummary(currentSession?.token);
    } catch (err: any) {
      setErrorMessage(err.message || String(err));
    } finally {
      setIsFinalizing(false);
    }
  };

  // --- Quick 1-Tap Payment Handlers ---
  const handleExactCashSale = () => {
    if (cartItems.length === 0 || isFinalizing) return;
    const totalRupees = totalGrossPaise / 100;
    handleFinalizeSale({
      cashTendered: totalRupees,
      cashAllocated: totalRupees,
      upiAllocated: 0,
    });
  };

  const handleQuickUpiFinalize = () => {
    if (cartItems.length === 0 || isFinalizing) return;
    const totalRupees = totalGrossPaise / 100;
    const source: PaymentVerificationSource = settlementPolicy === 'STRICT_GATEWAY_ONLY' ? 'GATEWAY_API' : 'SOUNDBOX_BROADCAST';
    handleFinalizeSale({
      cashTendered: 0,
      cashAllocated: 0,
      upiAllocated: totalRupees,
      upiVerificationSource: source,
    });
  };

  // --- RENDER 1: Initial Loading ---
  if (authLoading) {
    return (
      <div style={{ backgroundColor: '#F7F7F5', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center', color: '#8B1E2D' }}>
          <h2 style={{ margin: 0, fontSize: 24 }}>மால்குடி மிட்டாய்ஸ் — Malgudi Mithais POS</h2>
          <p style={{ color: '#666', marginTop: 8 }}>Initializing native SQLite data layer & security boundaries...</p>
        </div>
      </div>
    );
  }

  // --- RENDER 2: First-Run Owner Setup ---
  if (!isProvisioned) {
    return (
      <div style={{ backgroundColor: '#F7F7F5', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', padding: 20 }}>
        <div style={{ backgroundColor: '#FFF9F0', border: '2px solid #8B1E2D', borderRadius: 12, padding: 32, maxWidth: 480, width: '100%', boxShadow: '0 8px 24px rgba(139,30,45,0.12)' }}>
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <span style={{ fontSize: 36 }}>🏛️</span>
            <h1 style={{ color: '#8B1E2D', fontSize: 22, margin: '8px 0 4px 0' }}>Malgudi Mithais POS</h1>
            <h2 style={{ color: '#6F1623', fontSize: 16, margin: 0, fontWeight: 'normal' }}>First-Run Owner Provisioning</h2>
            <p style={{ color: '#555', fontSize: 13, marginTop: 8 }}>
              No user accounts exist in the database. Establish the primary Store Administrator / Owner account to activate this POS terminal.
            </p>
          </div>

          {authError && (
            <div style={{ backgroundColor: '#ffebee', color: '#c62828', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 13, border: '1px solid #ef9a9a' }}>
              <strong>Error:</strong> {authError}
            </div>
          )}

          <form onSubmit={handleProvisionOwner}>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                Owner Username / ID
              </label>
              <input
                type="text"
                value={provUsername}
                onChange={e => setProvUsername(e.target.value)}
                required
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                Owner Full Name
              </label>
              <input
                type="text"
                value={provDisplayName}
                onChange={e => setProvDisplayName(e.target.value)}
                required
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                Security PIN / Password (Min 4 chars)
              </label>
              <input
                type="password"
                value={provPin}
                onChange={e => setProvPin(e.target.value)}
                required
                placeholder="••••••"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 16, letterSpacing: 4, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                Confirm Security PIN
              </label>
              <input
                type="password"
                value={provConfirmPin}
                onChange={e => setProvConfirmPin(e.target.value)}
                required
                placeholder="••••••"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 16, letterSpacing: 4, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                  Assigned Store Branch
                </label>
                <select
                  value={provBranchId}
                  onChange={e => setProvBranchId(e.target.value)}
                  style={{ width: '100%', padding: '10px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 12, boxSizing: 'border-box', backgroundColor: '#fff' }}
                >
                  <option value="IB">IB - Iyer Bungalow Branch</option>
                  <option value="UK">UK - Umachikulam Branch</option>
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                  Terminal ID
                </label>
                <input
                  type="text"
                  value={provTerminalId}
                  onChange={e => setProvTerminalId(e.target.value.toUpperCase())}
                  required
                  placeholder="T1"
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box' }}
                />
              </div>
            </div>

            <button
              type="submit"
              style={{ width: '100%', padding: '12px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 'bold', fontSize: 15, cursor: 'pointer' }}
            >
              Activate POS & Establish Owner Account
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- RENDER 3: Terminal Login Screen ---
  if (!currentSession) {
    return (
      <div style={{ backgroundColor: '#F7F7F5', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', padding: 20 }}>
        <div style={{ backgroundColor: '#FFF9F0', border: '2px solid #8B1E2D', borderRadius: 12, padding: 32, maxWidth: 420, width: '100%', boxShadow: '0 8px 24px rgba(139,30,45,0.12)' }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <span style={{ fontSize: 32 }}>🏛️</span>
            <h1 style={{ color: '#8B1E2D', fontSize: 22, margin: '6px 0 2px 0' }}>மால்குடி மிட்டாய்ஸ்</h1>
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, backgroundColor: '#FFF0F2', border: '1px solid #FFCDD2', borderRadius: 20, padding: '4px 12px', fontSize: 12, color: '#8B1E2D', fontWeight: 700 }}>
                <span>📍</span>
                <span>{syncConfig ? `${syncConfig.branch_name} • Terminal ${syncConfig.terminal_id}` : 'Iyer Bungalow Branch (IB) • Terminal T1'}</span>
              </div>
            </div>
          </div>

          {authError && (
            <div style={{ backgroundColor: '#ffebee', color: '#c62828', padding: '10px 12px', borderRadius: 6, marginBottom: 16, fontSize: 13, border: '1px solid #ef9a9a' }}>
              <strong>Login Failed:</strong> {authError}
            </div>
          )}

          <form onSubmit={handleLogin}>
            {/* Quick Demo Credentials */}
            <div style={{ marginBottom: 16, padding: '10px 12px', backgroundColor: '#FFF3E0', border: '1px dashed #E65100', borderRadius: 8, textAlign: 'center' }}>
              <div style={{ fontSize: 11, fontWeight: 'bold', color: '#B26A00', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                Quick Login Credentials
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => {
                    setLoginUsername('owner');
                    setLoginPin('123456');
                    setAuthError(null);
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    backgroundColor: '#8B1E2D',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  👑 Owner (123456)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLoginUsername('staff');
                    setLoginPin('123456');
                    setAuthError(null);
                  }}
                  style={{
                    flex: 1,
                    padding: '8px 10px',
                    backgroundColor: '#2E7D32',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  👤 Staff (123456)
                </button>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                Username / Employee ID
              </label>
              <input
                type="text"
                value={loginUsername}
                onChange={e => setLoginUsername(e.target.value)}
                required
                autoFocus
                placeholder="owner or staff"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', color: '#1F1F1F', marginBottom: 4 }}>
                Security PIN / Password
              </label>
              <input
                type="password"
                value={loginPin}
                onChange={e => setLoginPin(e.target.value)}
                required
                placeholder="••••••"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 16, letterSpacing: 4, boxSizing: 'border-box' }}
              />
            </div>

            {/* Touch Keypad */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 16 }}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    if (k === 'C') setLoginPin('');
                    else if (k === '⌫') setLoginPin(p => p.slice(0, -1));
                    else setLoginPin(p => p + k);
                  }}
                  style={{ padding: '8px', fontSize: 14, fontWeight: 'bold', backgroundColor: '#f0f0f0', border: '1px solid #ddd', borderRadius: 4, cursor: 'pointer' }}
                >
                  {k}
                </button>
              ))}
            </div>

            <button
              type="submit"
              style={{ width: '100%', padding: '12px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 'bold', fontSize: 16, cursor: 'pointer' }}
            >
              Sign In to Terminal
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- RENDER 4: Authenticated POS Application ---
  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#F7F7F5', color: '#1F1F1F', overflow: 'hidden' }}>
      {/* 1. Compact Professional Application Header */}
      <header
        style={{
          height: 54,
          padding: '0 16px',
          backgroundColor: '#FFF9F0',
          borderBottom: '2px solid #8B1E2D',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
          boxShadow: '0 2px 4px rgba(0,0,0,0.04)',
          zIndex: 10,
        }}
      >
        {/* Brand & Context */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 22 }}>🏛️</span>
            <span style={{ color: '#8B1E2D', fontWeight: 800, fontSize: 17, letterSpacing: -0.2 }}>
              மால்குடி மிட்டாய்ஸ் <span style={{ fontWeight: 400, color: '#6F1623', fontSize: 14 }}>— Malgudi Mithais POS</span>
            </span>
          </div>

          <div style={{ height: 20, width: 1, backgroundColor: '#ddd' }} />

          <div style={{ fontSize: 12, color: '#555', display: 'flex', gap: 10, alignItems: 'center' }}>
            <span>
              📍 Branch: <strong style={{ color: '#8B1E2D' }}>{syncConfig?.branch_id || currentSession.branch_id}</strong>
              {' '}<span style={{ color: '#777', fontSize: 11 }}>({syncConfig?.terminal_id || currentSession.terminal_id || 'T1'})</span>
            </span>
            <span>•</span>
            <span>💰 Shift: <strong>{currentSession.session_id}</strong></span>
          </div>
        </div>

        {/* User Identity, Sync Status & Actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontSize: 12, color: '#444', display: 'flex', alignItems: 'center', gap: 6, backgroundColor: '#FFFDF9', padding: '4px 10px', borderRadius: 20, border: '1px solid #EAD8C7' }}>
            <span>👤 Cashier: <strong style={{ color: '#8B1E2D' }}>{currentSession.display_name}</strong> ({currentSession.role})</span>
          </div>

          {/* Real-time Live Cash Drawer Pill with Breakdown Popover */}
          {liveDrawerSummary && liveDrawerSummary.has_opening_float ? (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setShowDrawerBreakdown(prev => !prev)}
                title="Click to view full Day Cash Drawer Breakdown"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 12px',
                  borderRadius: 20,
                  backgroundColor: '#F0FDF4',
                  border: '1.5px solid #86EFAC',
                  color: '#166534',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: '0 1px 3px rgba(22,101,52,0.1)',
                  transition: 'all 0.15s ease-in-out',
                }}
              >
                <span style={{ fontSize: 13 }}>💵</span>
                <span>Till:</span>
                <span style={{ color: '#14532D', fontWeight: 900, fontSize: 13 }}>
                  ₹{(liveDrawerSummary.current_drawer_cash_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span style={{ fontSize: 10, color: '#15803D' }}>▾</span>
              </button>

              {/* Drawer Breakdown Popover */}
              {showDrawerBreakdown && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 8px)',
                    right: 0,
                    width: 290,
                    backgroundColor: '#FFFFFF',
                    border: '2px solid #8B1E2D',
                    borderRadius: 10,
                    padding: '12px 14px',
                    boxShadow: '0 10px 28px rgba(0,0,0,0.2)',
                    zIndex: 1100,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #F1E5D8', paddingBottom: 6, marginBottom: 8 }}>
                    <div style={{ fontWeight: 800, color: '#8B1E2D', fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span>💵</span> Live Cash Drawer
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowDrawerBreakdown(false)}
                      style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: 14 }}
                    >
                      ✕
                    </button>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#555' }}>
                      <span>☀️ Opening Float:</span>
                      <strong style={{ color: '#111' }}>
                        ₹{(liveDrawerSummary.opening_float_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#2E7D32' }}>
                      <span>🛒 Cash Sales (+):</span>
                      <strong>
                        +₹{(liveDrawerSummary.cash_sales_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </strong>
                    </div>
                    {liveDrawerSummary.cash_refunds_paise > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#C62828' }}>
                        <span>↩️ Cash Refunds (-):</span>
                        <strong>
                          -₹{(liveDrawerSummary.cash_refunds_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </strong>
                      </div>
                    )}
                    <div style={{ height: 1, backgroundColor: '#EAD8C7', margin: '4px 0' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                      <span style={{ fontWeight: 700, color: '#1E293B' }}>Expected In Drawer:</span>
                      <span style={{ fontWeight: 900, color: '#166534', fontSize: 15 }}>
                        ₹{(liveDrawerSummary.current_drawer_cash_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>

                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #E5E7EB', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: '#888' }}>
                      {liveDrawerSummary.is_day_closed ? '🔒 Day Closed' : '🟢 Shift Active'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowDrawerBreakdown(false);
                        handleOpenDayCloseModal();
                      }}
                      style={{
                        padding: '4px 8px',
                        fontSize: 10,
                        fontWeight: 700,
                        backgroundColor: '#FFF9F0',
                        color: '#8B1E2D',
                        border: '1px solid #8B1E2D',
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                    >
                      Day Close (Z-Report)
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsOpeningFloatModalOpen(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                borderRadius: 20,
                backgroundColor: '#FEF3C7',
                border: '1.5px solid #F59E0B',
                color: '#92400E',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(245,158,11,0.2)',
              }}
              title="Click to enter the starting cash float for today"
            >
              <span>⚠️</span>
              <span>Float Not Set</span>
              <span style={{ backgroundColor: '#D97706', color: '#fff', padding: '1px 6px', borderRadius: 10, fontSize: 10 }}>💵 Set Cash</span>
            </button>
          )}

          {/* Real-time Cloud Synchronization Badge & Quick Sync Button */}
          <div
            title={
              syncStatus?.last_sync_error
                ? `Sync Alert: ${syncStatus.last_sync_error}`
                : syncStatus?.last_sync_timestamp
                ? `Last Successful Sync: ${new Date(syncStatus.last_sync_timestamp).toLocaleTimeString()}`
                : 'No sync recorded yet'
            }
            style={{
              fontSize: 11,
              padding: '3px 8px',
              borderRadius: 4,
              backgroundColor:
                syncStatus?.last_sync_status === 'OFFLINE'
                  ? '#FFEBEE'
                  : syncStatus && syncStatus.pending_count > 0
                  ? '#FFF8E1'
                  : '#E8F5E9',
              color:
                syncStatus?.last_sync_status === 'OFFLINE'
                  ? '#C62828'
                  : syncStatus && syncStatus.pending_count > 0
                  ? '#F57F17'
                  : '#2E7D32',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${
                syncStatus?.last_sync_status === 'OFFLINE'
                  ? '#FFCDD2'
                  : syncStatus && syncStatus.pending_count > 0
                  ? '#FFE082'
                  : '#C8E6C9'
              }`,
            }}
          >
            <span>
              {syncStatus?.last_sync_status === 'OFFLINE'
                ? '🔴'
                : syncStatus && syncStatus.pending_count > 0
                ? '🟡'
                : '🟢'}
            </span>
            <span>
              {syncStatus?.last_sync_status === 'OFFLINE'
                ? `Offline (${syncStatus?.pending_count || 0} Pending)`
                : syncStatus && syncStatus.pending_count > 0
                ? `${syncStatus.pending_count} Pending Sync`
                : 'Cloud Synced'}
            </span>
            <button
              onClick={handleTriggerSync}
              disabled={isSyncing}
              title="Synchronize offline outbox events to central cloud server"
              style={{
                marginLeft: 4,
                padding: '1px 7px',
                fontSize: 10,
                backgroundColor: '#fff',
                border: '1px solid #ccc',
                borderRadius: 3,
                cursor: isSyncing ? 'not-allowed' : 'pointer',
                fontWeight: 700,
                color: '#333',
              }}
            >
              {isSyncing ? '⏳ Syncing...' : '⚡ Sync'}
            </button>
          </div>

          {/* OTA Auto-Update Header Quick Indicator */}
          {availableUpdate && (
            <button
              onClick={() => {
                if (currentSession.role === 'ADMIN') {
                  setActiveTab('owner_panel');
                  setOwnerSubTab('updates');
                } else {
                  setUpdateBannerDismissed(false);
                }
              }}
              title="Click to view and install software update"
              style={{
                backgroundColor: '#FEF3C7',
                color: '#B45309',
                border: '1px solid #F59E0B',
                borderRadius: 4,
                padding: '3px 8px',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <span>🚀</span>
              <span>v{availableUpdate.version} Available</span>
            </button>
          )}

          {currentSession.role === 'ADMIN' && (
            <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', border: '1px solid #8B1E2D' }}>
              <button
                onClick={() => setActiveTab('billing')}
                style={{
                  padding: '5px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  border: 'none',
                  backgroundColor: activeTab === 'billing' ? '#8B1E2D' : '#FFF9F0',
                  color: activeTab === 'billing' ? '#fff' : '#8B1E2D',
                  cursor: 'pointer',
                }}
              >
                🛒 Billing
              </button>
              <button
                onClick={() => {
                  setActiveTab('owner_panel');
                  loadAdminData();
                }}
                style={{
                  padding: '5px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                  border: 'none',
                  backgroundColor: activeTab === 'owner_panel' ? '#8B1E2D' : '#FFF9F0',
                  color: activeTab === 'owner_panel' ? '#fff' : '#8B1E2D',
                  cursor: 'pointer',
                }}
              >
                ⚙️ Owner Panel
              </button>
            </div>
          )}

          <button
            onClick={() => setIsHistoryModalOpen(true)}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: '#fff',
              color: '#333',
              border: '1px solid #ccc',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            📜 Invoices & Reprints
          </button>

          <button
            onClick={() => setIsSwitchModalOpen(true)}
            title="Hand over register to next shift cashier"
            style={{
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: '#FFF9F0',
              color: '#6F1623',
              border: '1px solid #6F1623',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            🔄 Shift Handover
          </button>

          <button
            onClick={handleOpenDayCloseModal}
            title="Perform Day-End Register Closure & Print 80mm Z-Report"
            style={{
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: 700,
              backgroundColor: '#8B1E2D',
              color: '#fff',
              border: '1px solid #6F1623',
              borderRadius: 4,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            🌙 Day Close & Z-Report
          </button>

          <button
            onClick={handleLogout}
            style={{
              padding: '5px 10px',
              fontSize: 12,
              fontWeight: 600,
              backgroundColor: '#eee',
              color: '#333',
              border: '1px solid #ddd',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            🚪 Logout
          </button>
        </div>
      </header>

      {/* Global OTA Software Update Banner */}
      {availableUpdate && !updateBannerDismissed && (
        <div
          style={{
            backgroundColor: '#FFFBEB',
            borderBottom: '2px solid #F59E0B',
            padding: '8px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 13,
            color: '#92400E',
            fontWeight: 600,
            zIndex: 20,
            boxShadow: '0 2px 8px rgba(245, 158, 11, 0.15)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 18 }}>✨</span>
            <span>
              <strong>New Software Update Available:</strong> Malgudi Mithais POS <strong>v{availableUpdate.version}</strong> is ready (Current: v{currentAppVersion}).
            </span>
            {updateStatusMessage && (
              <span style={{ fontSize: 12, color: '#B45309', fontWeight: 500 }}>
                • {updateStatusMessage}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {isUpdating ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ width: 140, height: 8, backgroundColor: '#FDE68A', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${updateProgressPercent}%`,
                      height: '100%',
                      backgroundColor: '#D97706',
                      transition: 'width 0.2s',
                    }}
                  />
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#B45309' }}>
                  {updateProgressPercent}%
                </span>
              </div>
            ) : (
              <>
                <button
                  onClick={handleApplyUpdate}
                  style={{
                    padding: '5px 14px',
                    backgroundColor: '#D97706',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 4,
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    boxShadow: '0 2px 4px rgba(217, 119, 6, 0.3)',
                  }}
                >
                  <span>⚡</span> Install & Restart
                </button>
                <button
                  onClick={() => setUpdateBannerDismissed(true)}
                  title="Dismiss banner for now"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#92400E',
                    cursor: 'pointer',
                    fontSize: 14,
                    padding: '3px 8px',
                    fontWeight: 700,
                  }}
                >
                  ✕
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* 2. Owner Management Panel (When in Owner Tab) */}
      {activeTab === 'owner_panel' && currentSession.role === 'ADMIN' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, backgroundColor: '#F7F7F5' }}>
          <div style={{ maxWidth: 1140, margin: '0 auto', backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 24, boxShadow: '0 2px 6px rgba(0,0,0,0.04)' }}>
            
            {/* Header & Subtabs */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h2 style={{ color: '#8B1E2D', fontSize: 18, margin: 0, fontWeight: 800 }}>
                  ⚙️ Store Administration & Inventory Management
                </h2>
                <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                  Branch: <strong style={{ color: '#8B1E2D' }}>{syncConfig?.branch_name || 'Iyer Bungalow Branch (IB)'}</strong> | Multi-Branch Synchronized | Owner/Admin Security
                </div>
              </div>

              {/* Subtabs Bar */}
              <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #8B1E2D' }}>
                <button
                  onClick={() => setOwnerSubTab('products')}
                  style={{
                    padding: '7px 16px',
                    fontSize: 12,
                    fontWeight: 700,
                    border: 'none',
                    backgroundColor: ownerSubTab === 'products' ? '#8B1E2D' : '#FFF9F0',
                    color: ownerSubTab === 'products' ? '#fff' : '#8B1E2D',
                    cursor: 'pointer',
                  }}
                >
                  📦 Products & Pricing
                </button>
                <button
                  onClick={() => {
                    setOwnerSubTab('stock');
                    loadStockMovements();
                  }}
                  style={{
                    padding: '7px 16px',
                    fontSize: 12,
                    fontWeight: 700,
                    border: 'none',
                    borderLeft: '1px solid #8B1E2D',
                    borderRight: '1px solid #8B1E2D',
                    backgroundColor: ownerSubTab === 'stock' ? '#8B1E2D' : '#FFF9F0',
                    color: ownerSubTab === 'stock' ? '#fff' : '#8B1E2D',
                    cursor: 'pointer',
                  }}
                >
                  📊 Stock & Inventory
                </button>
                <button
                  onClick={() => {
                    setOwnerSubTab('reports');
                    loadReports();
                  }}
                  style={{
                    padding: '7px 16px',
                    fontSize: 12,
                    fontWeight: 700,
                    border: 'none',
                    borderRight: '1px solid #8B1E2D',
                    backgroundColor: ownerSubTab === 'reports' ? '#8B1E2D' : '#FFF9F0',
                    color: ownerSubTab === 'reports' ? '#fff' : '#8B1E2D',
                    cursor: 'pointer',
                  }}
                >
                  📈 Sales & GST Reports
                </button>
                <button
                  onClick={() => setOwnerSubTab('users_security')}
                  style={{
                    padding: '7px 16px',
                    fontSize: 12,
                    fontWeight: 700,
                    border: 'none',
                    borderRight: '1px solid #8B1E2D',
                    backgroundColor: ownerSubTab === 'users_security' ? '#8B1E2D' : '#FFF9F0',
                    color: ownerSubTab === 'users_security' ? '#fff' : '#8B1E2D',
                    cursor: 'pointer',
                  }}
                >
                  👥 Staff & Security
                </button>
                <button
                  onClick={() => {
                    setOwnerSubTab('cloud_sync');
                    loadSyncConfig(currentSession?.token);
                    loadSyncStatus();
                  }}
                  style={{
                    padding: '7px 16px',
                    fontSize: 12,
                    fontWeight: 700,
                    border: 'none',
                    borderRight: '1px solid #8B1E2D',
                    backgroundColor: ownerSubTab === 'cloud_sync' ? '#8B1E2D' : '#FFF9F0',
                    color: ownerSubTab === 'cloud_sync' ? '#fff' : '#8B1E2D',
                    cursor: 'pointer',
                  }}
                >
                  ☁️ Cloud Sync & Branches
                </button>
                <button
                  onClick={() => setOwnerSubTab('updates')}
                  style={{
                    padding: '7px 16px',
                    fontSize: 12,
                    fontWeight: 700,
                    border: 'none',
                    backgroundColor: ownerSubTab === 'updates' ? '#8B1E2D' : '#FFF9F0',
                    color: ownerSubTab === 'updates' ? '#fff' : '#8B1E2D',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span>🔄 Software Updates</span>
                  {availableUpdate && (
                    <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#F59E0B' }} />
                  )}
                </button>
              </div>
            </div>

            {adminActionMessage && (
              <div style={{ backgroundColor: '#e8f5e9', color: '#2e7d32', padding: '10px 14px', borderRadius: 4, marginBottom: 16, fontSize: 13, border: '1px solid #c8e6c9' }}>
                ✓ {adminActionMessage}
              </div>
            )}
            {adminActionError && (
              <div style={{ backgroundColor: '#ffebee', color: '#c62828', padding: '10px 14px', borderRadius: 4, marginBottom: 16, fontSize: 13, border: '1px solid #ffcdd2' }}>
                ⚠️ {adminActionError}
              </div>
            )}

            {/* TAB 1: PRODUCTS & PRICING */}
            {ownerSubTab === 'products' && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 10, flex: 1, minWidth: 320 }}>
                    <input
                      type="text"
                      placeholder="🔍 Search name, Tamil, SKU, barcode..."
                      value={ownerProductSearch}
                      onChange={e => setOwnerProductSearch(e.target.value)}
                      style={{ flex: 1, padding: '8px 12px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
                    />
                    <select
                      value={ownerCategoryFilter}
                      onChange={e => setOwnerCategoryFilter(e.target.value)}
                      style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
                    >
                      <option value="all">All Categories</option>
                      {categories.filter(c => c.id !== 'all').map(c => (
                        <option key={c.id} value={c.id}>
                          {c.icon} {c.name} ({c.tamil_name})
                        </option>
                      ))}
                    </select>
                    <select
                      value={ownerStatusFilter}
                      onChange={e => setOwnerStatusFilter(e.target.value as any)}
                      style={{ padding: '8px 10px', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}
                    >
                      <option value="all">All Status</option>
                      <option value="active">Active Only</option>
                      <option value="inactive">Disabled Only</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setIsAddCategoryModalOpen(true)}
                      style={{
                        padding: '8px 14px',
                        backgroundColor: '#FFFDF9',
                        color: '#8B1E2D',
                        border: '1.5px solid #8B1E2D',
                        borderRadius: 6,
                        fontWeight: 700,
                        cursor: 'pointer',
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                      title="Add a custom product category"
                    >
                      <span>📁 Add Category</span>
                    </button>

                    <button
                      onClick={handleOpenAddProduct}
                      style={{
                        padding: '8px 16px',
                        backgroundColor: '#8B1E2D',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        fontWeight: 700,
                        cursor: 'pointer',
                        fontSize: 13,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <span>➕ Add New Product</span>
                    </button>
                  </div>
                </div>

                <div style={{ overflowX: 'auto', border: '1px solid #E5E5DF', borderRadius: 6 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA' }}>
                        <th style={{ padding: '10px 12px' }}>SKU / Barcode</th>
                        <th style={{ padding: '10px 12px' }}>Product Name & Tamil</th>
                        <th style={{ padding: '10px 12px' }}>Category</th>
                        <th style={{ padding: '10px 12px' }}>Selling Price</th>
                        <th style={{ padding: '10px 12px' }}>GST Rate</th>
                        <th style={{ padding: '10px 12px' }}>HSN</th>
                        <th style={{ padding: '10px 12px' }}>Branch Stock</th>
                        <th style={{ padding: '10px 12px' }}>Status</th>
                        <th style={{ padding: '10px 12px', textAlign: 'right' }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const filteredOwnerProducts = catalog.filter(p => {
                          if (ownerCategoryFilter !== 'all' && p.category_id !== ownerCategoryFilter) return false;
                          if (ownerStatusFilter === 'active' && !p.is_active) return false;
                          if (ownerStatusFilter === 'inactive' && p.is_active) return false;
                          if (ownerProductSearch.trim()) {
                            const q = ownerProductSearch.trim().toLowerCase();
                            return (
                              p.name.toLowerCase().includes(q) ||
                              p.tamil_name.toLowerCase().includes(q) ||
                              p.sku.toLowerCase().includes(q) ||
                              (p.barcode && p.barcode.toLowerCase().includes(q))
                            );
                          }
                          return true;
                        });
                        const pagedOwnerProducts = filteredOwnerProducts.slice(
                          (ownerProductsPage - 1) * OWNER_PRODUCTS_PER_PAGE,
                          ownerProductsPage * OWNER_PRODUCTS_PER_PAGE
                        );
                        if (filteredOwnerProducts.length === 0) {
                          return (
                            <tr>
                              <td colSpan={9} style={{ textAlign: 'center', padding: 24, color: '#888' }}>
                                No products found matching the filter criteria.
                              </td>
                            </tr>
                          );
                        }
                        return pagedOwnerProducts.map(prod => {
                          const stockFormatted = prod.pricing_unit === 'PER_KG'
                            ? `${(prod.current_stock / 1000000).toFixed(2)} kg`
                            : `${prod.current_stock} ${prod.stock_unit.toLowerCase()}`;

                          return (
                            <tr key={prod.id} style={{ borderBottom: '1px solid #eee', backgroundColor: prod.is_active ? '#fff' : '#FAF9F8' }}>
                              <td style={{ padding: '10px 12px' }}>
                                <div style={{ fontWeight: 700, fontFamily: 'monospace', color: '#333' }}>{prod.sku}</div>
                                {prod.barcode && <div style={{ fontSize: 11, color: '#777', fontFamily: 'monospace' }}>{prod.barcode}</div>}
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                <div style={{ fontWeight: 600, color: prod.is_active ? '#1F1F1F' : '#888' }}>{prod.name}</div>
                                {prod.tamil_name && prod.tamil_name.trim() !== '' && prod.tamil_name.trim().toLowerCase() !== prod.name.trim().toLowerCase() && (
                                  <div style={{ fontSize: 12, color: '#777' }}>{prod.tamil_name}</div>
                                )}
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, backgroundColor: '#F0F0EA', color: '#444', fontWeight: 600 }}>
                                  {prod.category_id.replace('cat_', '').toUpperCase()}
                                </span>
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                <strong style={{ color: '#8B1E2D' }}>₹{(prod.base_price_paise / 100).toFixed(2)}</strong>
                                <span style={{ fontSize: 11, color: '#666' }}>/{prod.pricing_unit === 'PER_KG' ? 'kg' : prod.pricing_unit.replace('PER_', '').toLowerCase()}</span>
                              </td>
                              <td style={{ padding: '10px 12px' }}>{prod.tax_rate_bps / 100}%</td>
                              <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: 12, color: '#555' }}>{prod.hsn_code}</td>
                              <td style={{ padding: '10px 12px' }}>
                                <span style={{ fontWeight: 700, color: prod.current_stock <= 0 ? '#C62828' : '#2E7D32' }}>
                                  {stockFormatted}
                                </span>
                              </td>
                              <td style={{ padding: '10px 12px' }}>
                                <span style={{
                                  fontSize: 11,
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  fontWeight: 700,
                                  backgroundColor: prod.is_active ? '#E8F5E9' : '#ECEFF1',
                                  color: prod.is_active ? '#2E7D32' : '#546E7A',
                                }}>
                                  {prod.is_active ? 'ACTIVE' : 'DISABLED'}
                                </span>
                              </td>
                              <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <button
                                  onClick={() => handleOpenStockAdjust(prod.id)}
                                  style={{
                                    padding: '4px 10px',
                                    fontSize: 12,
                                    backgroundColor: '#FFF5F5',
                                    color: '#8B1E2D',
                                    border: '1px solid #EAD8C7',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    marginRight: 6,
                                  }}
                                  title="Adjust physical inventory balance"
                                >
                                  📦 Stock
                                </button>
                                <button
                                  onClick={() => handleOpenEditProduct(prod)}
                                  style={{
                                    padding: '4px 10px',
                                    fontSize: 12,
                                    backgroundColor: '#FFF9F0',
                                    color: '#8B1E2D',
                                    border: '1px solid #8B1E2D',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                    marginRight: 6,
                                  }}
                                >
                                  ✏️ Edit
                                </button>
                                <button
                                  onClick={() => handleToggleProductStatus(prod)}
                                  style={{
                                    padding: '4px 8px',
                                    fontSize: 12,
                                    backgroundColor: prod.is_active ? '#FFF3E0' : '#E8F5E9',
                                    color: prod.is_active ? '#E65100' : '#2E7D32',
                                    border: prod.is_active ? '1px solid #FFE0B2' : '1px solid #C8E6C9',
                                    borderRadius: 4,
                                    cursor: 'pointer',
                                    fontWeight: 600,
                                  }}
                                >
                                  {prod.is_active ? 'Deactivate' : 'Activate'}
                                </button>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                  {(() => {
                    const filteredOwnerProducts = catalog.filter(p => {
                      if (ownerCategoryFilter !== 'all' && p.category_id !== ownerCategoryFilter) return false;
                      if (ownerStatusFilter === 'active' && !p.is_active) return false;
                      if (ownerStatusFilter === 'inactive' && p.is_active) return false;
                      if (ownerProductSearch.trim()) {
                        const q = ownerProductSearch.trim().toLowerCase();
                        return (
                          p.name.toLowerCase().includes(q) ||
                          p.tamil_name.toLowerCase().includes(q) ||
                          p.sku.toLowerCase().includes(q) ||
                          (p.barcode && p.barcode.toLowerCase().includes(q))
                        );
                      }
                      return true;
                    });
                    return renderPaginationBar(
                      ownerProductsPage,
                      filteredOwnerProducts.length,
                      OWNER_PRODUCTS_PER_PAGE,
                      setOwnerProductsPage
                    );
                  })()}
                </div>
              </div>
            )}

            {/* TAB 2: STOCK & INVENTORY OPERATIONS */}
            {ownerSubTab === 'stock' && (
              <div>
                {/* KPI Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
                  <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 14 }}>
                    <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Store Location</div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: '#8B1E2D', marginTop: 4 }}>Madurai Branch (IB)</div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>Terminal T1 / Counter C1</div>
                  </div>
                  <div style={{ backgroundColor: '#F9FBF9', border: '1px solid #D5E8D4', borderRadius: 8, padding: 14 }}>
                    <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Active Tracked Products</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#2E7D32', marginTop: 4 }}>
                      {catalog.filter(p => p.is_active).length} items
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>Physical inventory sync active</div>
                  </div>
                  <div style={{ backgroundColor: '#FFFBF5', border: '1px solid #FFE0B2', borderRadius: 8, padding: 14 }}>
                    <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Low Stock Alerts (&lt; 5kg / 10pc)</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: '#E65100', marginTop: 4 }}>
                      {catalog.filter(p => p.is_active && (p.pricing_unit === 'PER_KG' ? p.current_stock < 5000000 : p.current_stock < 10)).length} items
                    </div>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>Requires production/procurement</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      onClick={() => handleOpenStockAdjust()}
                      style={{
                        width: '100%',
                        padding: '12px 16px',
                        backgroundColor: '#8B1E2D',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 8,
                        fontWeight: 800,
                        cursor: 'pointer',
                        fontSize: 13,
                        boxShadow: '0 2px 6px rgba(139,30,45,0.2)',
                      }}
                    >
                      ⚖️ Record Stock Movement
                    </button>
                  </div>
                </div>

                {/* Stock Balances Summary */}
                <div style={{ marginBottom: 24 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h3 style={{ fontSize: 15, fontWeight: 800, color: '#333', margin: 0 }}>
                        Current Store Balances & Quick Adjust
                      </h3>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 12, backgroundColor: '#F0F0EA', color: '#555', fontWeight: 700 }}>
                        {catalog.length} items
                      </span>
                    </div>

                    {/* Filter Pills */}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button
                        type="button"
                        onClick={() => setStockTableFilter('all')}
                        style={{
                          padding: '4px 10px',
                          fontSize: 11,
                          fontWeight: 700,
                          borderRadius: 20,
                          border: stockTableFilter === 'all' ? '1px solid #8B1E2D' : '1px solid #ddd',
                          backgroundColor: stockTableFilter === 'all' ? '#8B1E2D' : '#fff',
                          color: stockTableFilter === 'all' ? '#fff' : '#555',
                          cursor: 'pointer',
                        }}
                      >
                        All ({catalog.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setStockTableFilter('out_of_stock')}
                        style={{
                          padding: '4px 10px',
                          fontSize: 11,
                          fontWeight: 700,
                          borderRadius: 20,
                          border: stockTableFilter === 'out_of_stock' ? '1px solid #C62828' : '1px solid #FFCDD2',
                          backgroundColor: stockTableFilter === 'out_of_stock' ? '#C62828' : '#FFEBEE',
                          color: stockTableFilter === 'out_of_stock' ? '#fff' : '#C62828',
                          cursor: 'pointer',
                        }}
                      >
                        🔴 Out of Stock / Negative ({catalog.filter(p => p.current_stock <= 0).length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setStockTableFilter('low_stock')}
                        style={{
                          padding: '4px 10px',
                          fontSize: 11,
                          fontWeight: 700,
                          borderRadius: 20,
                          border: stockTableFilter === 'low_stock' ? '1px solid #E65100' : '1px solid #FFE0B2',
                          backgroundColor: stockTableFilter === 'low_stock' ? '#E65100' : '#FFF3E0',
                          color: stockTableFilter === 'low_stock' ? '#fff' : '#E65100',
                          cursor: 'pointer',
                        }}
                      >
                        ⚠️ Low Stock ({catalog.filter(p => p.current_stock > 0 && (p.pricing_unit === 'PER_KG' ? p.current_stock < 5000000 : p.current_stock < 10)).length})
                      </button>
                    </div>
                  </div>

                  {/* Search and Category Filter Toolbar */}
                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    <div style={{ position: 'relative', flex: 1 }}>
                      <input
                        type="text"
                        placeholder="🔍 Search product name, Tamil name, or SKU (e.g. Rusk, ரஸ்க், BAK)..."
                        value={stockTableSearch}
                        onChange={e => setStockTableSearch(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '7px 32px 7px 10px',
                          border: '1px solid #ccc',
                          borderRadius: 6,
                          fontSize: 12,
                          boxSizing: 'border-box',
                        }}
                      />
                      {stockTableSearch && (
                        <button
                          type="button"
                          onClick={() => setStockTableSearch('')}
                          style={{
                            position: 'absolute',
                            right: 8,
                            top: '50%',
                            transform: 'translateY(-50%)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 12,
                            color: '#999',
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                    <select
                      value={stockTableCategory}
                      onChange={e => setStockTableCategory(e.target.value)}
                      style={{
                        padding: '7px 10px',
                        border: '1px solid #ccc',
                        borderRadius: 6,
                        fontSize: 12,
                        backgroundColor: '#fff',
                        cursor: 'pointer',
                      }}
                    >
                      <option value="all">All Categories</option>
                      {categories.filter(c => c.id !== 'all').map(c => (
                        <option key={c.id} value={c.id}>
                          {c.icon} {c.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Filtered Table */}
                  <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #E5E5DF', borderRadius: 6 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '1px solid #ddd', position: 'sticky', top: 0, zIndex: 1 }}>
                          <th style={{ padding: '8px 10px' }}>SKU</th>
                          <th style={{ padding: '8px 10px' }}>Product</th>
                          <th style={{ padding: '8px 10px' }}>Category</th>
                          <th style={{ padding: '8px 10px' }}>Current Stock</th>
                          <th style={{ padding: '8px 10px' }}>Unit</th>
                          <th style={{ padding: '8px 10px', textAlign: 'right' }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(() => {
                          const filtered = catalog.filter(prod => {
                            if (stockTableCategory !== 'all' && prod.category_id !== stockTableCategory) return false;
                            if (stockTableFilter === 'out_of_stock' && prod.current_stock > 0) return false;
                            if (stockTableFilter === 'low_stock') {
                              const isLow = prod.current_stock > 0 && (prod.pricing_unit === 'PER_KG' ? prod.current_stock < 5000000 : prod.current_stock < 10);
                              if (!isLow) return false;
                            }
                            if (stockTableSearch.trim()) {
                              const q = stockTableSearch.trim().toLowerCase();
                              return (
                                prod.name.toLowerCase().includes(q) ||
                                prod.tamil_name.toLowerCase().includes(q) ||
                                prod.sku.toLowerCase().includes(q) ||
                                (prod.barcode && prod.barcode.toLowerCase().includes(q))
                              );
                            }
                            return true;
                          });

                          if (filtered.length === 0) {
                            return (
                              <tr>
                                <td colSpan={6} style={{ textAlign: 'center', padding: '24px 12px', color: '#888' }}>
                                  No items found matching {stockTableSearch ? `"${stockTableSearch}"` : 'the selected filter'}.
                                </td>
                              </tr>
                            );
                          }

                          return filtered.map(prod => {
                            const isNegativeOrZero = prod.current_stock <= 0;
                            const isLow = !isNegativeOrZero && (prod.pricing_unit === 'PER_KG' ? prod.current_stock < 5000000 : prod.current_stock < 10);
                            const unitDisplay = prod.pricing_unit === 'PER_KG' ? 'KG' : prod.inventory_unit;

                            return (
                              <tr
                                key={prod.id}
                                style={{
                                  borderBottom: '1px solid #eee',
                                  backgroundColor: isNegativeOrZero ? '#FFF9F9' : '#fff',
                                }}
                              >
                                <td style={{ padding: '8px 10px', fontFamily: 'monospace', fontWeight: 'bold' }}>{prod.sku}</td>
                                <td style={{ padding: '8px 10px' }}>
                                  <strong>{prod.name}</strong>
                                  {prod.tamil_name && prod.tamil_name.trim() !== '' && prod.tamil_name.trim().toLowerCase() !== prod.name.trim().toLowerCase() && (
                                    <span style={{ color: '#777', fontSize: 11, marginLeft: 6 }}>({prod.tamil_name})</span>
                                  )}
                                </td>
                                <td style={{ padding: '8px 10px' }}>
                                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, backgroundColor: '#F0F0EA', color: '#555', fontWeight: 600 }}>
                                    {prod.category_id.replace('cat_', '').toUpperCase()}
                                  </span>
                                </td>
                                <td style={{ padding: '8px 10px', fontWeight: 700, color: isNegativeOrZero ? '#C62828' : isLow ? '#E65100' : '#2E7D32' }}>
                                  {prod.pricing_unit === 'PER_KG' ? `${(prod.current_stock / 1000000).toFixed(2)} kg` : `${prod.current_stock} pcs`}
                                  {isNegativeOrZero && <span style={{ fontSize: 10, marginLeft: 4, color: '#C62828', fontWeight: 600 }}>(Deficit)</span>}
                                </td>
                                <td style={{ padding: '8px 10px', fontSize: 11, color: '#666' }}>{unitDisplay}</td>
                                <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                                  <button
                                    onClick={() => handleOpenStockAdjust(prod.id)}
                                    style={{
                                      padding: '4px 10px',
                                      fontSize: 11,
                                      backgroundColor: '#8B1E2D',
                                      color: '#fff',
                                      border: 'none',
                                      borderRadius: 4,
                                      cursor: 'pointer',
                                      fontWeight: 600,
                                    }}
                                  >
                                    Adjust
                                  </button>
                                </td>
                              </tr>
                            );
                          });
                        })()}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Audit Trail: Stock Movements Log */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <h3 style={{ fontSize: 14, color: '#333', margin: 0 }}>📋 Inventory Movement Audit Log (Mandatory Reasons)</h3>
                    <button
                      onClick={() => loadStockMovements()}
                      style={{ padding: '4px 8px', fontSize: 11, backgroundColor: '#eee', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer' }}
                    >
                      🔄 Refresh Log
                    </button>
                  </div>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #E5E5DF', borderRadius: 6 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                          <th style={{ padding: '8px 10px' }}>Type</th>
                          <th style={{ padding: '8px 10px' }}>Product</th>
                          <th style={{ padding: '8px 10px' }}>Delta</th>
                          <th style={{ padding: '8px 10px' }}>Mandatory Audit Reason</th>
                          <th style={{ padding: '8px 10px' }}>Actor</th>
                          <th style={{ padding: '8px 10px' }}>Reference</th>
                          <th style={{ padding: '8px 10px' }}>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stockMovements.length === 0 ? (
                          <tr>
                            <td colSpan={7} style={{ textAlign: 'center', padding: 20, color: '#888' }}>
                              No stock movements recorded yet. Click 'Record Stock Movement' to adjust stock.
                            </td>
                          </tr>
                        ) : (
                          stockMovements
                            .slice((stockMovementsPage - 1) * STOCK_MOVEMENTS_PER_PAGE, stockMovementsPage * STOCK_MOVEMENTS_PER_PAGE)
                            .map(sm => {
                            const prod = catalog.find(p => p.id === sm.product_id);
                            const prodName = prod ? prod.name : sm.product_id;
                            const isPositive = sm.quantity_delta > 0;
                            const displayDelta = prod?.pricing_unit === 'PER_KG'
                              ? `${(sm.quantity_delta / 1000000).toFixed(2)} kg`
                              : `${sm.quantity_delta} ${sm.unit.toLowerCase()}`;

                            return (
                              <tr key={sm.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                                <td style={{ padding: '8px 10px', fontWeight: 700 }}>
                                  <span style={{
                                    fontSize: 10,
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    backgroundColor: sm.movement_type.includes('RECEIPT') || sm.movement_type === 'OPENING_STOCK' || sm.movement_type === 'VOID_STOCK_REVERSAL' ? '#E8F5E9' : '#FFEBEE',
                                    color: sm.movement_type.includes('RECEIPT') || sm.movement_type === 'OPENING_STOCK' || sm.movement_type === 'VOID_STOCK_REVERSAL' ? '#2E7D32' : '#C62828',
                                  }}>
                                    {sm.movement_type}
                                  </span>
                                </td>
                                <td style={{ padding: '8px 10px' }}>{prodName}</td>
                                <td style={{ padding: '8px 10px', fontWeight: 700, color: isPositive ? '#2E7D32' : '#C62828' }}>
                                  {isPositive ? `+${displayDelta}` : displayDelta}
                                </td>
                                <td style={{ padding: '8px 10px', color: '#333' }}>{sm.reason || '—'}</td>
                                <td style={{ padding: '8px 10px', fontFamily: 'monospace' }}>{sm.actor_id || 'system'}</td>
                                <td style={{ padding: '8px 10px', color: '#666', fontSize: 11 }}>{sm.reference_id}</td>
                                <td style={{ padding: '8px 10px', color: '#666' }}>{sm.created_at}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                    {renderPaginationBar(stockMovementsPage, stockMovements.length, STOCK_MOVEMENTS_PER_PAGE, setStockMovementsPage)}
                  </div>
                </div>
              </div>
            )}

            {/* TAB 3: SALES & GST FINANCIAL REPORTS */}
            {ownerSubTab === 'reports' && (
              <div>
                {/* Reports Header & Global Date Filters */}
                <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 16, marginBottom: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
                    <div>
                      <h3 style={{ fontSize: 16, margin: 0, color: '#8B1E2D', fontWeight: 800 }}>
                        📈 Sales, GST & Financial Reconciliation Reports
                      </h3>
                      <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                        Branch: <strong>{syncConfig?.branch_name || 'Iyer Bungalow Branch (IB)'}</strong> • Authoritative SQLite Transaction Data
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        onClick={handleExportCurrentReportCsv}
                        disabled={!reportsData}
                        style={{
                          padding: '7px 14px',
                          fontSize: 12,
                          fontWeight: 700,
                          backgroundColor: '#2E7D32',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 6,
                          cursor: reportsData ? 'pointer' : 'not-allowed',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          opacity: reportsData ? 1 : 0.6,
                        }}
                      >
                        📊 Export {activeReportView.toUpperCase()} (Excel / CSV)
                      </button>

                      <button
                        onClick={() => loadReports()}
                        disabled={reportsLoading}
                        style={{
                          padding: '7px 14px',
                          fontSize: 12,
                          fontWeight: 700,
                          backgroundColor: '#8B1E2D',
                          color: '#fff',
                          border: 'none',
                          borderRadius: 6,
                          cursor: reportsLoading ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {reportsLoading ? '⏳ Loading...' : '🔄 Refresh'}
                      </button>
                    </div>
                  </div>

                  {/* Date Filter & Presets Row */}
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', paddingTop: 10, borderTop: '1px solid #F0E6DD' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {[
                        { id: 'today', label: 'Today' },
                        { id: 'yesterday', label: 'Yesterday' },
                        { id: 'this_month', label: 'This Month' },
                        { id: 'last_30_days', label: 'Last 30 Days' },
                      ].map(p => (
                        <button
                          key={p.id}
                          onClick={() => handleSetDatePreset(p.id as any)}
                          style={{
                            padding: '4px 10px',
                            fontSize: 11,
                            fontWeight: 600,
                            backgroundColor: '#fff',
                            border: '1px solid #D0C0B0',
                            borderRadius: 4,
                            cursor: 'pointer',
                            color: '#444',
                          }}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginLeft: 'auto' }}>
                      <span style={{ fontWeight: 600, color: '#555' }}>Date Range:</span>
                      <input
                        type="date"
                        value={reportStartDate}
                        onChange={e => {
                          setReportStartDate(e.target.value);
                          loadReports(e.target.value, reportEndDate);
                        }}
                        style={{ padding: '4px 8px', fontSize: 12, border: '1px solid #ccc', borderRadius: 4 }}
                      />
                      <span>to</span>
                      <input
                        type="date"
                        value={reportEndDate}
                        onChange={e => {
                          setReportEndDate(e.target.value);
                          loadReports(reportStartDate, e.target.value);
                        }}
                        style={{ padding: '4px 8px', fontSize: 12, border: '1px solid #ccc', borderRadius: 4 }}
                      />
                    </div>
                  </div>
                </div>

                {reportsError && (
                  <div style={{ backgroundColor: '#FFEBEE', color: '#C62828', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 13, border: '1px solid #FFCDD2' }}>
                    ⚠️ {reportsError}
                  </div>
                )}

                {/* Sub-view Selector Pills */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '2px solid #EAD8C7', paddingBottom: 10 }}>
                  {[
                    { id: 'daily', label: '📅 Daily Sales Summary' },
                    { id: 'payments', label: '💳 Payment Summary' },
                    { id: 'gst', label: '🧾 GST Tax Slabs & Invoices' },
                    { id: 'products', label: '🏷️ Product & Category Sales' },
                    { id: 'drawer', label: '🗄️ Cash Drawer & Movements' },
                    { id: 'zreport', label: '📋 Day-End Z-Reports' },
                  ].map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => {
                        setActiveReportView(tab.id as any);
                        if (tab.id === 'zreport' && !archiveZReportData) {
                          handleLoadArchiveZReport(archiveZReportDate);
                        }
                      }}
                      style={{
                        padding: '8px 16px',
                        fontSize: 13,
                        fontWeight: 700,
                        border: 'none',
                        borderRadius: 6,
                        cursor: 'pointer',
                        backgroundColor: activeReportView === tab.id ? '#8B1E2D' : '#F0EBE5',
                        color: activeReportView === tab.id ? '#fff' : '#555',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* VIEW 1: DAILY SALES SUMMARY */}
                {activeReportView === 'daily' && reportsData && (
                  <div>
                    {/* KPI Cards */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
                      <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Active Net Revenue</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#8B1E2D', marginTop: 4 }}>
                          ₹{(reportsData.daily_sales.net_sales_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#2E7D32', marginTop: 2 }}>Excludes voided/refunded bills</div>
                      </div>

                      <div style={{ backgroundColor: '#F9FBF9', border: '1px solid #D5E8D4', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Invoices Generated</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#2E7D32', marginTop: 4 }}>
                          {reportsData.daily_sales.active_bills_count} bills
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                          Total recorded: {reportsData.daily_sales.total_bills_recorded}
                        </div>
                      </div>

                      <div style={{ backgroundColor: '#F0F4F8', border: '1px solid #D0E0EE', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Taxable Value & GST</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#1565C0', marginTop: 4 }}>
                          ₹{(reportsData.daily_sales.taxable_sales_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                          + GST: ₹{(reportsData.daily_sales.total_tax_paise / 100).toFixed(2)}
                        </div>
                      </div>

                      <div style={{ backgroundColor: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Voided Bills & Returns</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#C62828', marginTop: 4 }}>
                          {reportsData.daily_sales.voided_bills_count} bills
                        </div>
                        <div style={{ fontSize: 11, color: '#C62828', marginTop: 2 }}>
                          Refunded: ₹{(reportsData.daily_sales.voided_amount_paise / 100).toFixed(2)}
                        </div>
                      </div>
                    </div>

                    {/* Daily Breakdown Table */}
                    <div style={{ overflowX: 'auto', border: '1px solid #E5E5DF', borderRadius: 8, backgroundColor: '#fff' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA' }}>
                            <th style={{ padding: '10px 12px' }}>Business Date</th>
                            <th style={{ padding: '10px 12px' }}>Total Bills</th>
                            <th style={{ padding: '10px 12px' }}>Active</th>
                            <th style={{ padding: '10px 12px' }}>Voided</th>
                            <th style={{ padding: '10px 12px' }}>Taxable Sales (₹)</th>
                            <th style={{ padding: '10px 12px' }}>Total GST (₹)</th>
                            <th style={{ padding: '10px 12px' }}>Gross Sales (₹)</th>
                            <th style={{ padding: '10px 12px' }}>Voided Amount (₹)</th>
                            <th style={{ padding: '10px 12px', textAlign: 'right' }}>Net Sales (₹)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportsData.daily_sales.daily_breakdown.length === 0 ? (
                            <tr>
                              <td colSpan={9} style={{ textAlign: 'center', padding: 24, color: '#888' }}>
                                No transactions recorded for the selected date range.
                              </td>
                            </tr>
                          ) : (
                            reportsData.daily_sales.daily_breakdown.map((row, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '10px 12px', fontWeight: 700 }}>{row.business_date}</td>
                                <td style={{ padding: '10px 12px' }}>{row.total_bills}</td>
                                <td style={{ padding: '10px 12px', color: '#2E7D32', fontWeight: 600 }}>{row.active_bills}</td>
                                <td style={{ padding: '10px 12px', color: row.voided_bills > 0 ? '#C62828' : '#888', fontWeight: 600 }}>{row.voided_bills}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(row.taxable_sales_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(row.total_tax_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(row.gross_sales_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px', color: row.voided_amount_paise > 0 ? '#C62828' : '#888' }}>
                                  ₹{(row.voided_amount_paise / 100).toFixed(2)}
                                </td>
                                <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, color: '#8B1E2D' }}>
                                  ₹{(row.net_sales_paise / 100).toFixed(2)}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                        {reportsData.daily_sales.daily_breakdown.length > 0 && (
                          <tfoot>
                            <tr style={{ backgroundColor: '#FFFDF9', fontWeight: 800, borderTop: '2px solid #8B1E2D' }}>
                              <td style={{ padding: '10px 12px' }}>TOTAL</td>
                              <td style={{ padding: '10px 12px' }}>{reportsData.daily_sales.total_bills_recorded}</td>
                              <td style={{ padding: '10px 12px', color: '#2E7D32' }}>{reportsData.daily_sales.active_bills_count}</td>
                              <td style={{ padding: '10px 12px', color: '#C62828' }}>{reportsData.daily_sales.voided_bills_count}</td>
                              <td style={{ padding: '10px 12px' }}>₹{(reportsData.daily_sales.taxable_sales_paise / 100).toFixed(2)}</td>
                              <td style={{ padding: '10px 12px' }}>₹{(reportsData.daily_sales.total_tax_paise / 100).toFixed(2)}</td>
                              <td style={{ padding: '10px 12px' }}>₹{(reportsData.daily_sales.gross_sales_paise / 100).toFixed(2)}</td>
                              <td style={{ padding: '10px 12px', color: '#C62828' }}>₹{(reportsData.daily_sales.voided_amount_paise / 100).toFixed(2)}</td>
                              <td style={{ padding: '10px 12px', textAlign: 'right', color: '#8B1E2D' }}>₹{(reportsData.daily_sales.net_sales_paise / 100).toFixed(2)}</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                )}

                {/* VIEW 2: PAYMENT SUMMARY */}
                {activeReportView === 'payments' && reportsData && (
                  <div>
                    {/* Payment KPI Cards */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
                      <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>💵 Net Cash Realized</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#8B1E2D', marginTop: 4 }}>
                          ₹{(reportsData.payment_summary.net_cash_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                          Gross: ₹{(reportsData.payment_summary.total_cash_collected_paise / 100).toFixed(2)} | Ref: ₹{(reportsData.payment_summary.cash_refunds_paise / 100).toFixed(2)}
                        </div>
                      </div>

                      <div style={{ backgroundColor: '#EDE7F6', border: '1px solid #D1C4E9', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#5E35B1', textTransform: 'uppercase', fontWeight: 700 }}>📱 Net UPI Realized</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#4527A0', marginTop: 4 }}>
                          ₹{(reportsData.payment_summary.net_upi_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                          Gross: ₹{(reportsData.payment_summary.total_upi_collected_paise / 100).toFixed(2)} | Ref: ₹{(reportsData.payment_summary.upi_refunds_paise / 100).toFixed(2)}
                        </div>
                      </div>

                      <div style={{ backgroundColor: '#E8F5E9', border: '1px solid #C8E6C9', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#2E7D32', textTransform: 'uppercase', fontWeight: 700 }}>⚡ Split Tender Transactions</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#1B5E20', marginTop: 4 }}>
                          {reportsData.payment_summary.total_split_bills_count} bills
                        </div>
                        <div style={{ fontSize: 11, color: '#2E7D32', marginTop: 2 }}>
                          Total volume: ₹{(reportsData.payment_summary.total_split_amount_paise / 100).toFixed(2)}
                        </div>
                      </div>

                      <div style={{ backgroundColor: '#F0F4F8', border: '1px solid #CFD8DC', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#455A64', textTransform: 'uppercase', fontWeight: 700 }}>Total Collections Realized</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#263238', marginTop: 4 }}>
                          ₹{(reportsData.payment_summary.total_net_collected_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>Cash + UPI Net Inflow</div>
                      </div>
                    </div>

                    {/* Cash Tender Reconciliation Banner */}
                    <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 14, marginBottom: 20 }}>
                      <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: '#8B1E2D' }}>
                        ⚖️ Cash Drawer Tender & Change Reconciliation
                      </h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 12 }}>
                        <div>
                          <span style={{ color: '#666' }}>Total Customer Tendered Cash:</span>
                          <div style={{ fontWeight: 800, fontSize: 16, color: '#1F1F1F', marginTop: 2 }}>
                            ₹{(reportsData.payment_summary.total_cash_tendered_paise / 100).toFixed(2)}
                          </div>
                        </div>
                        <div>
                          <span style={{ color: '#666' }}>Change Returned to Customers:</span>
                          <div style={{ fontWeight: 800, fontSize: 16, color: '#D32F2F', marginTop: 2 }}>
                            ₹{(reportsData.payment_summary.total_change_returned_paise / 100).toFixed(2)}
                          </div>
                        </div>
                        <div>
                          <span style={{ color: '#666' }}>Net Physical Cash Deposited in Drawer:</span>
                          <div style={{ fontWeight: 800, fontSize: 16, color: '#2E7D32', marginTop: 2 }}>
                            ₹{(reportsData.payment_summary.total_cash_collected_paise / 100).toFixed(2)}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Payment Methods Table */}
                    <div style={{ overflowX: 'auto', border: '1px solid #E5E5DF', borderRadius: 8, backgroundColor: '#fff' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA' }}>
                            <th style={{ padding: '10px 12px' }}>Payment Method</th>
                            <th style={{ padding: '10px 12px' }}>Billed Invoices</th>
                            <th style={{ padding: '10px 12px' }}>Gross Collected (₹)</th>
                            <th style={{ padding: '10px 12px' }}>Refunds / Reversals (₹)</th>
                            <th style={{ padding: '10px 12px' }}>Net Realized (₹)</th>
                            <th style={{ padding: '10px 12px', textAlign: 'right' }}>% Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportsData.payment_summary.methods_breakdown.map((row, idx) => {
                            const share = reportsData.payment_summary.total_net_collected_paise > 0
                              ? ((row.net_amount_paise / reportsData.payment_summary.total_net_collected_paise) * 100).toFixed(1)
                              : '0.0';
                            return (
                              <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '10px 12px', fontWeight: 700 }}>
                                  {row.payment_method === 'CASH' ? '💵 Cash Tender' : '📱 UPI / QR Gateway'}
                                </td>
                                <td style={{ padding: '10px 12px' }}>{row.bills_count}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(row.total_collected_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px', color: row.refunds_paise > 0 ? '#C62828' : '#888' }}>
                                  ₹{(row.refunds_paise / 100).toFixed(2)}
                                </td>
                                <td style={{ padding: '10px 12px', fontWeight: 800, color: '#8B1E2D' }}>
                                  ₹{(row.net_amount_paise / 100).toFixed(2)}
                                </td>
                                <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>
                                  {share}%
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* VIEW 3: GST TAX REPORT */}
                {activeReportView === 'gst' && reportsData && (
                  <div>
                    {/* GST KPI Cards */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 20 }}>
                      <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Total Taxable Base</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#8B1E2D', marginTop: 4 }}>
                          ₹{(reportsData.gst_report.total_taxable_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>Net taxable turnover</div>
                      </div>

                      <div style={{ backgroundColor: '#E3F2FD', border: '1px solid #90CAF9', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#1565C0', textTransform: 'uppercase', fontWeight: 700 }}>Central GST (CGST)</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#0D47A1', marginTop: 4 }}>
                          ₹{(reportsData.gst_report.total_cgst_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#1565C0', marginTop: 2 }}>2.5% on standard sweets</div>
                      </div>

                      <div style={{ backgroundColor: '#E8F5E9', border: '1px solid #A5D6A7', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#2E7D32', textTransform: 'uppercase', fontWeight: 700 }}>State GST (SGST)</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#1B5E20', marginTop: 4 }}>
                          ₹{(reportsData.gst_report.total_sgst_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#2E7D32', marginTop: 2 }}>Tamil Nadu SGST (33)</div>
                      </div>

                      <div style={{ backgroundColor: '#FFF8E1', border: '1px solid #FFE082', borderRadius: 8, padding: 14 }}>
                        <div style={{ fontSize: 11, color: '#F57F17', textTransform: 'uppercase', fontWeight: 700 }}>Total GST Inflow</div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: '#E65100', marginTop: 4 }}>
                          ₹{(reportsData.gst_report.total_gst_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 11, color: '#F57F17', marginTop: 2 }}>CGST + SGST combined</div>
                      </div>
                    </div>

                    {/* Slab-wise GST Table */}
                    <div style={{ marginBottom: 20 }}>
                      <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#333' }}>
                        📊 GST Slab-wise Tax Breakdown (For GSTR-1 / GSTR-3B Filings)
                      </h4>
                      <div style={{ overflowX: 'auto', border: '1px solid #E5E5DF', borderRadius: 8, backgroundColor: '#fff' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA' }}>
                              <th style={{ padding: '10px 12px' }}>Tax Slab Rate</th>
                              <th style={{ padding: '10px 12px' }}>Taxable Turnover (₹)</th>
                              <th style={{ padding: '10px 12px' }}>CGST (₹)</th>
                              <th style={{ padding: '10px 12px' }}>SGST (₹)</th>
                              <th style={{ padding: '10px 12px' }}>Total GST (₹)</th>
                              <th style={{ padding: '10px 12px', textAlign: 'right' }}>Total Invoice Value (₹)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportsData.gst_report.slabs_breakdown.map((slab, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '10px 12px', fontWeight: 700 }}>
                                  <span style={{ padding: '3px 8px', borderRadius: 4, backgroundColor: '#FFF3E0', color: '#E65100', fontWeight: 800 }}>
                                    {slab.tax_rate_percent.toFixed(1)}% GST
                                  </span>
                                </td>
                                <td style={{ padding: '10px 12px' }}>₹{(slab.taxable_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(slab.cgst_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(slab.sgst_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px', fontWeight: 700, color: '#E65100' }}>
                                  ₹{(slab.total_tax_paise / 100).toFixed(2)}
                                </td>
                                <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, color: '#8B1E2D' }}>
                                  ₹{(slab.total_gross_paise / 100).toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Detailed Invoice-Level GST Table */}
                    <div>
                      <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#333' }}>
                        📋 Invoice-Level GST Audit Trail
                      </h4>
                      <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #E5E5DF', borderRadius: 8, backgroundColor: '#fff' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA', position: 'sticky', top: 0 }}>
                              <th style={{ padding: '8px 10px' }}>Invoice #</th>
                              <th style={{ padding: '8px 10px' }}>Date</th>
                              <th style={{ padding: '8px 10px' }}>Status</th>
                              <th style={{ padding: '8px 10px' }}>HSN Codes</th>
                              <th style={{ padding: '8px 10px' }}>Taxable (₹)</th>
                              <th style={{ padding: '8px 10px' }}>CGST (₹)</th>
                              <th style={{ padding: '8px 10px' }}>SGST (₹)</th>
                              <th style={{ padding: '8px 10px' }}>Total GST (₹)</th>
                              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Net Payable (₹)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportsData.gst_report.invoice_details.map((inv, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #eee', backgroundColor: inv.sale_status === 'VOIDED' ? '#FFEBEE' : '#fff' }}>
                                <td style={{ padding: '8px 10px', fontWeight: 700, fontFamily: 'monospace' }}>{inv.invoice_number}</td>
                                <td style={{ padding: '8px 10px', color: '#666' }}>{inv.business_date}</td>
                                <td style={{ padding: '8px 10px' }}>
                                  <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700, backgroundColor: inv.sale_status === 'VOIDED' ? '#FFCDD2' : '#E8F5E9', color: inv.sale_status === 'VOIDED' ? '#C62828' : '#2E7D32' }}>
                                    {inv.sale_status}
                                  </span>
                                </td>
                                <td style={{ padding: '8px 10px', fontFamily: 'monospace', color: '#555' }}>{inv.hsn_summary}</td>
                                <td style={{ padding: '8px 10px' }}>₹{(inv.taxable_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '8px 10px' }}>₹{(inv.cgst_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '8px 10px' }}>₹{(inv.sgst_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '8px 10px', fontWeight: 600 }}>₹{(inv.total_tax_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#8B1E2D' }}>
                                  ₹{(inv.net_payable_paise / 100).toFixed(2)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {/* VIEW 4: PRODUCT SALES REPORT */}
                {activeReportView === 'products' && reportsData && (
                  <div>
                    {/* Top Selling Products Banner */}
                    <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 14, marginBottom: 20 }}>
                      <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#8B1E2D', fontWeight: 800 }}>
                        🏆 Top 5 Best-Selling Delicacies
                      </h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
                        {reportsData.product_sales.top_selling.map((item, idx) => (
                          <div key={idx} style={{ backgroundColor: '#fff', border: '1px solid #E0D0C0', borderRadius: 6, padding: 10, position: 'relative' }}>
                            <div style={{ position: 'absolute', top: 6, right: 6, fontSize: 10, fontWeight: 800, backgroundColor: '#8B1E2D', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              #{idx + 1}
                            </div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#1F1F1F', marginBottom: 2, paddingRight: 20 }}>
                              {item.product_name}
                            </div>
                            <div style={{ fontSize: 11, color: '#777', marginBottom: 6 }}>{item.tamil_name}</div>
                            <div style={{ fontSize: 14, fontWeight: 900, color: '#8B1E2D' }}>
                              ₹{(item.gross_paise / 100).toFixed(2)}
                            </div>
                            <div style={{ fontSize: 11, color: '#2E7D32', fontWeight: 600 }}>
                              {item.quantity_formatted} sold
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Category-wise Breakdown Table */}
                    <div style={{ marginBottom: 20 }}>
                      <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#333' }}>
                        📂 Category Revenue Contribution
                      </h4>
                      <div style={{ overflowX: 'auto', border: '1px solid #E5E5DF', borderRadius: 8, backgroundColor: '#fff' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA' }}>
                              <th style={{ padding: '10px 12px' }}>Category Name</th>
                              <th style={{ padding: '10px 12px' }}>Unique Items Sold</th>
                              <th style={{ padding: '10px 12px' }}>Taxable Sales (₹)</th>
                              <th style={{ padding: '10px 12px' }}>GST Tax (₹)</th>
                              <th style={{ padding: '10px 12px' }}>Gross Revenue (₹)</th>
                              <th style={{ padding: '10px 12px', textAlign: 'right' }}>% Revenue Share</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportsData.product_sales.categories.map((cat, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '10px 12px', fontWeight: 700, color: '#8B1E2D' }}>{cat.category_name}</td>
                                <td style={{ padding: '10px 12px' }}>{cat.items_count}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(cat.taxable_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(cat.tax_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px', fontWeight: 700 }}>₹{(cat.gross_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800 }}>{cat.revenue_share_percent}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Detailed Product Sales Table */}
                    <div>
                      <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#333' }}>
                        📋 Individual Product Sales Performance
                      </h4>
                      <div style={{ overflowX: 'auto', border: '1px solid #E5E5DF', borderRadius: 8, backgroundColor: '#fff' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA' }}>
                              <th style={{ padding: '10px 12px' }}>SKU</th>
                              <th style={{ padding: '10px 12px' }}>Product & Tamil Name</th>
                              <th style={{ padding: '10px 12px' }}>Category</th>
                              <th style={{ padding: '10px 12px' }}>Quantity Sold</th>
                              <th style={{ padding: '10px 12px' }}>Bills Count</th>
                              <th style={{ padding: '10px 12px' }}>Taxable (₹)</th>
                              <th style={{ padding: '10px 12px' }}>GST (₹)</th>
                              <th style={{ padding: '10px 12px' }}>Gross Revenue (₹)</th>
                              <th style={{ padding: '10px 12px', textAlign: 'right' }}>Revenue Share</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportsData.product_sales.products.map((p, idx) => (
                              <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontWeight: 600 }}>{p.sku}</td>
                                <td style={{ padding: '10px 12px' }}>
                                  <div style={{ fontWeight: 600 }}>{p.product_name}</div>
                                  <div style={{ fontSize: 11, color: '#777' }}>{p.tamil_name}</div>
                                </td>
                                <td style={{ padding: '10px 12px' }}>
                                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: '#F0F0EA', color: '#444' }}>
                                    {p.category_id.replace('cat_', '').toUpperCase()}
                                  </span>
                                </td>
                                <td style={{ padding: '10px 12px', fontWeight: 700, color: '#2E7D32' }}>{p.quantity_formatted}</td>
                                <td style={{ padding: '10px 12px' }}>{p.bills_count}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(p.taxable_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px' }}>₹{(p.tax_paise / 100).toFixed(2)}</td>
                                <td style={{ padding: '10px 12px', fontWeight: 800, color: '#8B1E2D' }}>
                                  ₹{(p.gross_paise / 100).toFixed(2)}
                                </td>
                                <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>{p.revenue_share_percent}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {/* VIEW 5: CASH DRAWER REPORT */}
                {activeReportView === 'drawer' && reportsData && (
                  <div>
                    {/* Cash Drawer KPI Cards */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
                      <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 10, color: '#777', textTransform: 'uppercase', fontWeight: 700 }}>Opening Float</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#8B1E2D', marginTop: 4 }}>
                          ₹{(reportsData.cash_drawer.opening_float_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>Session start balance</div>
                      </div>

                      <div style={{ backgroundColor: '#E8F5E9', border: '1px solid #C8E6C9', borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 10, color: '#2E7D32', textTransform: 'uppercase', fontWeight: 700 }}>Cash Sales (IN)</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#1B5E20', marginTop: 4 }}>
                          +₹{(reportsData.cash_drawer.cash_sales_inflow_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: '#2E7D32', marginTop: 2 }}>From billing sales</div>
                      </div>

                      <div style={{ backgroundColor: '#FFEBEE', border: '1px solid #FFCDD2', borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 10, color: '#C62828', textTransform: 'uppercase', fontWeight: 700 }}>Cash Refunds (OUT)</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#B71C1C', marginTop: 4 }}>
                          -₹{(reportsData.cash_drawer.cash_refunds_outflow_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: '#C62828', marginTop: 2 }}>Voided sales payouts</div>
                      </div>

                      <div style={{ backgroundColor: '#F0F4F8', border: '1px solid #CFD8DC', borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 10, color: '#455A64', textTransform: 'uppercase', fontWeight: 700 }}>Net Cash Inflow</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#263238', marginTop: 4 }}>
                          ₹{(reportsData.cash_drawer.net_cash_change_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>Sales - Refunds</div>
                      </div>

                      <div style={{ backgroundColor: '#FFF9C4', border: '1px solid #FFF59D', borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 10, color: '#F57F17', textTransform: 'uppercase', fontWeight: 700 }}>Expected Closing Cash</div>
                        <div style={{ fontSize: 20, fontWeight: 900, color: '#E65100', marginTop: 4 }}>
                          ₹{(reportsData.cash_drawer.expected_closing_cash_paise / 100).toFixed(2)}
                        </div>
                        <div style={{ fontSize: 10, color: '#F57F17', marginTop: 2 }}>Drawer total to verify</div>
                      </div>
                    </div>

                    {/* Cash Movement Ledger Table */}
                    <div>
                      <h4 style={{ margin: '0 0 10px 0', fontSize: 14, color: '#333' }}>
                        📜 Cash Drawer Movement Ledger
                      </h4>
                      <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #E5E5DF', borderRadius: 8, backgroundColor: '#fff' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead>
                            <tr style={{ backgroundColor: '#F9F9F7', textAlign: 'left', borderBottom: '2px solid #E0E0DA', position: 'sticky', top: 0 }}>
                              <th style={{ padding: '8px 10px' }}>Timestamp</th>
                              <th style={{ padding: '8px 10px' }}>Movement Type</th>
                              <th style={{ padding: '8px 10px' }}>Direction</th>
                              <th style={{ padding: '8px 10px' }}>Reference / Invoice</th>
                              <th style={{ padding: '8px 10px' }}>Session ID</th>
                              <th style={{ padding: '8px 10px', textAlign: 'right' }}>Amount (₹)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportsData.cash_drawer.movements.length === 0 ? (
                              <tr>
                                <td colSpan={6} style={{ textAlign: 'center', padding: 20, color: '#888' }}>
                                  No cash movements found in the selected range.
                                </td>
                              </tr>
                            ) : (
                              reportsData.cash_drawer.movements
                                .slice((drawerMovementsPage - 1) * DRAWER_MOVEMENTS_PER_PAGE, drawerMovementsPage * DRAWER_MOVEMENTS_PER_PAGE)
                                .map((mov, idx) => (
                                <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                                  <td style={{ padding: '8px 10px', color: '#666' }}>{mov.created_at}</td>
                                  <td style={{ padding: '8px 10px', fontWeight: 600 }}>{mov.movement_type}</td>
                                  <td style={{ padding: '8px 10px' }}>
                                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, fontWeight: 700, backgroundColor: mov.direction === 'IN' ? '#E8F5E9' : '#FFEBEE', color: mov.direction === 'IN' ? '#2E7D32' : '#C62828' }}>
                                      {mov.direction}
                                    </span>
                                  </td>
                                  <td style={{ padding: '8px 10px', fontFamily: 'monospace' }}>{mov.reference_id}</td>
                                  <td style={{ padding: '8px 10px', color: '#666' }}>{mov.session_id}</td>
                                  <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: mov.direction === 'IN' ? '#2E7D32' : '#C62828' }}>
                                    {mov.direction === 'IN' ? '+' : '-'}₹{(mov.amount_paise / 100).toFixed(2)}
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                        {renderPaginationBar(drawerMovementsPage, reportsData.cash_drawer.movements.length, DRAWER_MOVEMENTS_PER_PAGE, setDrawerMovementsPage)}
                      </div>
                    </div>
                  </div>
                )}

                {/* VIEW 6: Day-End Closure & Z-Report Historical Archive */}
                {activeReportView === 'zreport' && (
                  <div>
                    {/* Date Selector Banner */}
                    <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 16, marginBottom: 20 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                        <div>
                          <h4 style={{ margin: 0, color: '#8B1E2D', fontSize: 15, fontWeight: 800 }}>
                            📋 Historical Day-End Z-Report Archive (முடிவு ரொக்கம் & தணிக்கை அறிக்கை)
                          </h4>
                          <div style={{ fontSize: 11, color: '#666', marginTop: 3 }}>
                            Inspect official end-of-day register closures, cash variance audits, and reprint 80mm thermal Z-slips for any date.
                          </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => {
                              const today = new Date().toISOString().split('T')[0];
                              setArchiveZReportDate(today);
                              handleLoadArchiveZReport(today);
                            }}
                            style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, backgroundColor: '#FFF9F0', border: '1px solid #8B1E2D', borderRadius: 4, color: '#8B1E2D', cursor: 'pointer' }}
                          >
                            Today
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const yest = new Date(Date.now() - 86400000).toISOString().split('T')[0];
                              setArchiveZReportDate(yest);
                              handleLoadArchiveZReport(yest);
                            }}
                            style={{ padding: '6px 12px', fontSize: 12, fontWeight: 600, backgroundColor: '#FFF9F0', border: '1px solid #8B1E2D', borderRadius: 4, color: '#8B1E2D', cursor: 'pointer' }}
                          >
                            Yesterday
                          </button>

                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 6 }}>
                            <input
                              type="date"
                              value={archiveZReportDate}
                              onChange={e => setArchiveZReportDate(e.target.value)}
                              style={{ padding: '6px 10px', fontSize: 12, border: '1px solid #ccc', borderRadius: 4 }}
                            />
                            <button
                              type="button"
                              onClick={() => handleLoadArchiveZReport(archiveZReportDate)}
                              disabled={archiveZReportLoading}
                              style={{
                                padding: '6px 14px',
                                fontSize: 12,
                                fontWeight: 700,
                                backgroundColor: '#8B1E2D',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 4,
                                cursor: archiveZReportLoading ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {archiveZReportLoading ? '⏳ Loading...' : '🔍 Fetch Z-Report'}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Report Output */}
                    {archiveZReportLoading ? (
                      <div style={{ textAlign: 'center', padding: '40px 20px', color: '#666', backgroundColor: '#fff', borderRadius: 8, border: '1px solid #ddd' }}>
                        <div style={{ fontSize: 24, marginBottom: 8 }}>⏳</div>
                        <div style={{ fontWeight: 600 }}>Aggregating authoritative Day-End Z-Report records from SQLite...</div>
                      </div>
                    ) : archiveZReportData ? (
                      <div>
                        {/* Summary Top Bar */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFF9F0', border: '2px solid #8B1E2D', borderRadius: 8, padding: '14px 18px', marginBottom: 20 }}>
                          <div>
                            <div style={{ fontSize: 17, fontWeight: 800, color: '#8B1E2D' }}>
                              🏛️ Malgudi Mithais • Day-End Z-Report for {archiveZReportData.business_date}
                            </div>
                            <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                              Branch: <strong>{archiveZReportData.branch_name}</strong> • Terminal: <strong>{archiveZReportData.terminal_id}</strong> • Closed by: <strong>{archiveZReportData.closed_by_user}</strong> ({archiveZReportData.closed_at ? formatDateTime(archiveZReportData.closed_at) : 'Auto-rollover / Session active'})
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => setActiveZReportModal(archiveZReportData)}
                            style={{
                              padding: '9px 18px',
                              backgroundColor: '#8B1E2D',
                              color: '#fff',
                              border: 'none',
                              borderRadius: 6,
                              fontWeight: 700,
                              fontSize: 13,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              boxShadow: '0 2px 4px rgba(139,30,45,0.2)',
                            }}
                          >
                            🖨️ View & Print 80mm Thermal Z-Slip
                          </button>
                        </div>

                        {/* 4 Cards Grid */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 20 }}>
                          {/* Card 1: Cash Drawer Variance */}
                          <div style={{ backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: '#8B1E2D', marginBottom: 12, borderBottom: '1px solid #eee', paddingBottom: 6 }}>
                              💵 Cash Drawer Reconciliation
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>Opening Cash Float:</span>
                              <strong>₹{(archiveZReportData.opening_float_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>(+) Cash Sales In:</span>
                              <strong style={{ color: '#2E7D32' }}>+₹{(archiveZReportData.cash_sales_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>(-) Cash Refunds Out:</span>
                              <strong style={{ color: '#C62828' }}>-₹{(archiveZReportData.cash_refunds_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, borderTop: '1px dashed #ccc', paddingTop: 6 }}>
                              <span style={{ color: '#444', fontWeight: 600 }}>Expected Drawer Cash:</span>
                              <strong>₹{(archiveZReportData.expected_closing_cash_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 10 }}>
                              <span style={{ color: '#444', fontWeight: 600 }}>Counted Closing Cash:</span>
                              <strong>₹{(archiveZReportData.counted_closing_cash_paise / 100).toFixed(2)}</strong>
                            </div>

                            <div style={{
                              padding: '8px 10px',
                              borderRadius: 6,
                              backgroundColor: archiveZReportData.variance_paise === 0 ? '#E8F5E9' : archiveZReportData.variance_paise > 0 ? '#FFF8E1' : '#FFEBEE',
                              color: archiveZReportData.variance_paise === 0 ? '#2E7D32' : archiveZReportData.variance_paise > 0 ? '#F57F17' : '#C62828',
                              fontWeight: 700,
                              fontSize: 12,
                              textAlign: 'center',
                            }}>
                              {archiveZReportData.variance_paise === 0
                                ? '✨ PERFECT MATCH (₹0.00 Variance)'
                                : archiveZReportData.variance_paise > 0
                                ? `▲ OVERAGE: +₹${(archiveZReportData.variance_paise / 100).toFixed(2)}`
                                : `▼ SHORTAGE: -₹${(Math.abs(archiveZReportData.variance_paise) / 100).toFixed(2)}`}
                            </div>
                            {archiveZReportData.variance_notes && (
                              <div style={{ fontSize: 11, color: '#666', marginTop: 8, fontStyle: 'italic' }}>
                                Notes: {archiveZReportData.variance_notes}
                              </div>
                            )}
                          </div>

                          {/* Card 2: Sales & Volume */}
                          <div style={{ backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: '#8B1E2D', marginBottom: 12, borderBottom: '1px solid #eee', paddingBottom: 6 }}>
                              📊 Sales & Invoice Volumes
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>Total Bills Generated:</span>
                              <strong>{archiveZReportData.total_bills_recorded}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>Active Settled Bills:</span>
                              <strong style={{ color: '#2E7D32' }}>{archiveZReportData.active_bills_count}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>Voided / Cancelled:</span>
                              <strong style={{ color: archiveZReportData.voided_bills_count > 0 ? '#C62828' : '#666' }}>{archiveZReportData.voided_bills_count}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6, borderTop: '1px dashed #ccc', paddingTop: 6 }}>
                              <span style={{ color: '#444', fontWeight: 600 }}>Gross Sales Turnover:</span>
                              <strong style={{ fontSize: 13, color: '#8B1E2D' }}>₹{(archiveZReportData.gross_sales_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                              <span style={{ color: '#444', fontWeight: 600 }}>Net Realized Revenue:</span>
                              <strong style={{ fontSize: 13, color: '#2E7D32' }}>₹{(archiveZReportData.net_sales_paise / 100).toFixed(2)}</strong>
                            </div>
                          </div>

                          {/* Card 3: Payment Tender Breakdown */}
                          <div style={{ backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: '#8B1E2D', marginBottom: 12, borderBottom: '1px solid #eee', paddingBottom: 6 }}>
                              💳 Payment Method Split
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                              <span style={{ color: '#666' }}>💵 Cash Payments:</span>
                              <strong>₹{(archiveZReportData.cash_realized_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 8 }}>
                              <span style={{ color: '#666' }}>📱 UPI / Soundbox:</span>
                              <strong>₹{(archiveZReportData.upi_realized_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderTop: '1px dashed #ccc', paddingTop: 8 }}>
                              <span style={{ color: '#444', fontWeight: 700 }}>Total Collections:</span>
                              <strong style={{ color: '#8B1E2D' }}>
                                ₹{((archiveZReportData.cash_realized_paise + archiveZReportData.upi_realized_paise) / 100).toFixed(2)}
                              </strong>
                            </div>
                          </div>

                          {/* Card 4: GST Tax Breakdown */}
                          <div style={{ backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 16 }}>
                            <div style={{ fontSize: 13, fontWeight: 800, color: '#8B1E2D', marginBottom: 12, borderBottom: '1px solid #eee', paddingBottom: 6 }}>
                              🧾 GST Tax Breakdown (5%)
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>Taxable Sales (Ex-Tax):</span>
                              <strong>₹{(archiveZReportData.total_taxable_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>CGST (2.5%):</span>
                              <strong>₹{(archiveZReportData.total_cgst_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                              <span style={{ color: '#666' }}>SGST (2.5%):</span>
                              <strong>₹{(archiveZReportData.total_sgst_paise / 100).toFixed(2)}</strong>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderTop: '1px dashed #ccc', paddingTop: 6 }}>
                              <span style={{ color: '#444', fontWeight: 700 }}>Total GST Payable:</span>
                              <strong style={{ color: '#2E7D32' }}>₹{(archiveZReportData.total_tax_paise / 100).toFixed(2)}</strong>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', padding: '40px 20px', color: '#666', backgroundColor: '#fff', borderRadius: 8, border: '1px solid #ddd' }}>
                        <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
                        <div style={{ fontWeight: 700, fontSize: 15, color: '#333', marginBottom: 4 }}>
                          No Day-End Z-Report Loaded Yet
                        </div>
                        <div style={{ fontSize: 13, color: '#666', maxWidth: 440, margin: '0 auto' }}>
                          Select any date above and click <strong>Fetch Z-Report</strong> to view the register closure records, cash drawer variances, and reprint 80mm thermal receipts.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB 4: STAFF & SECURITY SETTINGS */}
            {ownerSubTab === 'users_security' && (
              <div>
                {/* Store Terminal Payment Settlement Mode */}
            <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 16, marginBottom: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h3 style={{ fontSize: 14, margin: 0, color: '#8B1E2D', fontWeight: 800 }}>
                  💳 Payment Settlement Mode (Retail Counter)
                </h3>
                <span style={{ fontSize: 11, padding: '3px 8px', borderRadius: 12, backgroundColor: settlementPolicy === 'STRICT_GATEWAY_ONLY' ? '#E3F2FD' : '#E8F5E9', color: settlementPolicy === 'STRICT_GATEWAY_ONLY' ? '#1565C0' : '#2E7D32', fontWeight: 'bold' }}>
                  Active: {settlementPolicy === 'STRICT_GATEWAY_ONLY' ? 'Strict Gateway Webhook' : 'Shop Soundbox & Cash'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 13, flex: 1, minWidth: 260 }}>
                  <input
                    type="radio"
                    name="ownerSettlementPolicy"
                    checked={settlementPolicy === 'CASHIER_ASSERTION_PERMITTED'}
                    onChange={() => handleUpdateSettlementPolicy('CASHIER_ASSERTION_PERMITTED')}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <strong style={{ fontSize: 13, color: '#1F1F1F', display: 'block' }}>Soundbox Audio Alert (Standard Retail)</strong>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      Cashiers record UPI payments after hearing the counter soundbox voice alert (PhonePe/Paytm/GPay).
                    </div>
                  </div>
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 13, flex: 1, minWidth: 260 }}>
                  <input
                    type="radio"
                    name="ownerSettlementPolicy"
                    checked={settlementPolicy === 'STRICT_GATEWAY_ONLY'}
                    onChange={() => handleUpdateSettlementPolicy('STRICT_GATEWAY_ONLY')}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <strong style={{ fontSize: 13, color: '#1F1F1F', display: 'block' }}>Strict Bank Gateway Only</strong>
                    <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                      Requires automated bank webhook confirmation before invoices can be finalized.
                    </div>
                  </div>
                </label>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24, marginBottom: 24 }}>
              {/* Users List */}
              <div>
                <h3 style={{ fontSize: 14, margin: '0 0 10px 0', color: '#333' }}>Staff & Cashier Accounts</h3>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9f9f9', textAlign: 'left', borderBottom: '2px solid #eee' }}>
                      <th style={{ padding: 8 }}>Username</th>
                      <th style={{ padding: 8 }}>Name</th>
                      <th style={{ padding: 8 }}>Role</th>
                      <th style={{ padding: 8 }}>Status</th>
                      <th style={{ padding: 8 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userList.map(u => (
                      <tr key={u.id} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: 8, fontWeight: 'bold' }}>{u.username}</td>
                        <td style={{ padding: 8 }}>{u.display_name}</td>
                        <td style={{ padding: 8 }}>
                          <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: u.role === 'ADMIN' ? '#ede7f6' : '#e0f2f1', color: u.role === 'ADMIN' ? '#4527a0' : '#00695c', fontWeight: 'bold' }}>
                            {u.role}
                          </span>
                        </td>
                        <td style={{ padding: 8 }}>
                          <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: u.status === 'ACTIVE' ? '#e8f5e9' : '#ffebee', color: u.status === 'ACTIVE' ? '#2e7d32' : '#c62828', fontWeight: 'bold' }}>
                            {u.status}
                          </span>
                        </td>
                        <td style={{ padding: 8 }}>
                          <button
                            onClick={() => handleToggleUserStatus(u)}
                            style={{ padding: '3px 8px', fontSize: 11, marginRight: 6, backgroundColor: '#f5f5f5', border: '1px solid #ccc', borderRadius: 3, cursor: 'pointer' }}
                          >
                            {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => { setResetPinUserId(u.id); setResetPinValue(''); }}
                            style={{ padding: '3px 8px', fontSize: 11, marginRight: 6, backgroundColor: '#f5f5f5', border: '1px solid #ccc', borderRadius: 3, cursor: 'pointer' }}
                          >
                            Reset PIN
                          </button>
                          <button
                            onClick={() => handleDeleteUser(u)}
                            style={{ padding: '3px 8px', fontSize: 11, backgroundColor: '#FFF0F0', border: '1px solid #FFCDD2', color: '#C62828', borderRadius: 3, cursor: 'pointer', fontWeight: 600 }}
                            title="Permanently delete user account"
                          >
                            🗑️ Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {resetPinUserId && (
                  <form onSubmit={handleExecutePinReset} style={{ marginTop: 14, padding: 12, backgroundColor: '#FFF9F0', border: '1px solid #8B1E2D', borderRadius: 6 }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: 13, color: '#8B1E2D' }}>Reset PIN for User</h4>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="password"
                        placeholder="New 4-6 digit PIN"
                        value={resetPinValue}
                        onChange={e => setResetPinValue(e.target.value)}
                        required
                        style={{ padding: 6, fontSize: 13, flex: 1 }}
                      />
                      <button type="submit" style={{ padding: '6px 12px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer' }}>
                        Save New PIN
                      </button>
                      <button type="button" onClick={() => setResetPinUserId(null)} style={{ padding: '6px 10px', backgroundColor: '#ccc', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Create User Form */}
              <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 16 }}>
                <h3 style={{ fontSize: 14, margin: '0 0 12px 0', color: '#8B1E2D' }}>+ Create New Staff Account</h3>
                <form onSubmit={handleCreateCashier}>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 'bold' }}>Username / ID</label>
                    <input
                      type="text"
                      placeholder="e.g. anand_m"
                      value={newCashierUsername}
                      onChange={e => setNewCashierUsername(e.target.value)}
                      required
                      style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 'bold' }}>Display Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Anand M"
                      value={newCashierDisplayName}
                      onChange={e => setNewCashierDisplayName(e.target.value)}
                      required
                      style={{ width: '100%', padding: 6, fontSize: 13, boxSizing: 'border-box' }}
                    />
                  </div>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 'bold' }}>Role</label>
                    <select
                      value={newCashierRole}
                      onChange={e => setNewCashierRole(e.target.value as any)}
                      style={{ width: '100%', padding: 6, fontSize: 13 }}
                    >
                      <option value="CASHIER">Cashier (Billing & Reprints Only)</option>
                      <option value="ADMIN">Administrator / Owner</option>
                    </select>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 'bold' }}>Initial Security PIN</label>
                    <input
                      type="password"
                      placeholder="••••••"
                      value={newCashierPin}
                      onChange={e => setNewCashierPin(e.target.value)}
                      required
                      style={{ width: '100%', padding: 6, fontSize: 14, letterSpacing: 2, boxSizing: 'border-box' }}
                    />
                  </div>
                  <button
                    type="submit"
                    style={{ width: '100%', padding: '10px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 'bold', fontSize: 13, cursor: 'pointer' }}
                  >
                    👤 Create Staff Account
                  </button>
                </form>

                <div style={{ marginTop: 20, paddingTop: 14, borderTop: '1px dashed #ccc' }}>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: 13, color: '#333', display: 'flex', alignItems: 'center', gap: 6 }}>
                    🛡️ Data Safety & Local Backup
                  </h4>
                  {dbInfo && (
                    <div style={{ fontSize: 11, color: '#555', marginBottom: 10, lineHeight: 1.5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span>System Health:</span>
                        <strong style={{ color: '#2E7D32', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', backgroundColor: '#2E7D32' }}></span>
                          Protected (Power-loss Safe)
                        </strong>
                      </div>
                      <div>
                        Invoices on Register: <strong>{dbInfo.total_sales}</strong> • Cloud Sync: <strong>{dbInfo.pending_sync_count} pending</strong>
                      </div>
                    </div>
                  )}
                  <button
                    onClick={handleTriggerBackup}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      backgroundColor: '#263238',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 'bold',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
                    }}
                  >
                    💾 Backup Store Data Now
                  </button>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4, textAlign: 'center' }}>
                    Safely creates a snapshot copy of all sales and stock without interrupting billing
                  </div>
                </div>
              </div>
            </div>

            {/* Audit Logs */}
            <div>
              <h3 style={{ fontSize: 14, margin: '0 0 8px 0', color: '#333' }}>Recent Security Audit Events</h3>
              <div style={{ border: '1px solid #eee', borderRadius: 4 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9f9f9', textAlign: 'left', borderBottom: '1px solid #ddd' }}>
                      <th style={{ padding: 6 }}>Action</th>
                      <th style={{ padding: 6 }}>Entity</th>
                      <th style={{ padding: 6 }}>Actor</th>
                      <th style={{ padding: 6 }}>Timestamp</th>
                    </tr>
                  </thead>
                  <tbody>
                    {securityLogs.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: 18, color: '#888' }}>
                          No audit events recorded yet.
                        </td>
                      </tr>
                    ) : (
                      securityLogs
                        .slice((securityLogsPage - 1) * SECURITY_LOGS_PER_PAGE, securityLogsPage * SECURITY_LOGS_PER_PAGE)
                        .map(log => (
                          <tr key={log.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                            <td style={{ padding: 6, fontWeight: 'bold', color: log.action.includes('FAIL') || log.action.includes('BLOCKED') ? '#c62828' : '#2e7d32' }}>
                              {log.action}
                            </td>
                            <td style={{ padding: 6 }}>{log.entity_type}: {log.entity_id}</td>
                            <td style={{ padding: 6 }}>{log.actor_id}</td>
                            <td style={{ padding: 6, color: '#666' }}>{new Date(parseInt(log.created_at) * 1000 || Date.now()).toLocaleTimeString()}</td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
                {renderPaginationBar(securityLogsPage, securityLogs.length, SECURITY_LOGS_PER_PAGE, setSecurityLogsPage)}
              </div>
            </div>
          </div>
        )}

        {/* TAB 5: CLOUD SYNC & MULTI-BRANCH CONFIGURATION */}
        {ownerSubTab === 'cloud_sync' && (
          <div>
            {/* 1. Header & Live Synchronization Metrics */}
            <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 20, marginBottom: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontSize: 16, margin: 0, color: '#8B1E2D', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>☁️</span> Offline Outbox Queue & Central Cloud Synchronization
                  </h3>
                  <p style={{ fontSize: 12, color: '#666', margin: '4px 0 0 0' }}>
                    Durable offline queue ensures local POS billing continues with 100% reliability during internet outages. Records upload automatically upon reconnection.
                  </p>
                </div>

                <button
                  onClick={handleTriggerSync}
                  disabled={isSyncing}
                  style={{
                    padding: '10px 18px',
                    backgroundColor: isSyncing ? '#7A1A28' : '#8B1E2D',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: isSyncing ? 'wait' : 'pointer',
                    opacity: isSyncing ? 0.72 : 1,
                    filter: isSyncing ? 'blur(0.8px)' : 'none',
                    transform: isSyncing ? 'scale(0.98)' : 'scale(1)',
                    transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    boxShadow: isSyncing ? 'none' : '0 2px 6px rgba(139,30,45,0.25)',
                  }}
                >
                  <span>{isSyncing ? '⏳' : '⚡'}</span>
                  <span>{isSyncing ? 'Synchronizing (Outbox & Inbound)...' : 'Synchronize Now (Bidirectional)'}</span>
                </button>
              </div>

              {syncMessage && (
                <div style={{ backgroundColor: syncMessage.includes('fail') || syncMessage.includes('Error') ? '#FFEBEE' : '#E8F5E9', color: syncMessage.includes('fail') || syncMessage.includes('Error') ? '#C62828' : '#2E7D32', padding: '10px 14px', borderRadius: 6, marginBottom: 16, fontSize: 13, border: '1px solid #C8E6C9' }}>
                  {syncMessage.includes('fail') ? '⚠️' : '✓'} {syncMessage}
                </div>
              )}

              {(syncStatus?.last_sync_error || syncStatus?.last_inbound_sync_error) && (
                <div style={{ backgroundColor: '#FFF3E0', border: '1px solid #FFE0B2', color: '#E65100', padding: '12px 16px', borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
                  <div style={{ fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>⚠️</span> Actionable Error Recovery Alert
                  </div>
                  <div>{syncStatus?.last_sync_error || syncStatus?.last_inbound_sync_error}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    Billing continues uninterrupted in offline mode. Changes are safely queued in local SQLite outbox.
                  </div>
                </div>
              )}

              {/* 6 Comprehensive Dashboard Metric Tiles */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
                <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase' }}>Outbox Pending</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: syncStatus && syncStatus.pending_count > 0 ? '#F57F17' : '#2E7D32', marginTop: 4 }}>
                    {syncStatus ? syncStatus.pending_count : 0}
                  </div>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Queued locally</div>
                </div>

                <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase' }}>Outbox Synced</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#2E7D32', marginTop: 4 }}>
                    {syncStatus ? syncStatus.synced_count : 0}
                  </div>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Server acknowledged</div>
                </div>

                <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase' }}>Catalog Version</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#1565C0', marginTop: 4 }}>
                    v{syncStatus?.last_inbound_catalog_version || 1}
                  </div>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Incremental sequence</div>
                </div>

                <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase' }}>Inbound Catalog</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: syncStatus?.last_inbound_sync_status === 'ONLINE' ? '#2E7D32' : '#F57F17', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>{syncStatus?.last_inbound_sync_status === 'ONLINE' ? '🟢' : '🟡'}</span>
                    <span>{syncStatus?.last_inbound_sync_status || 'ONLINE'}</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                    {syncStatus?.last_inbound_sync_timestamp ? new Date(syncStatus.last_inbound_sync_timestamp).toLocaleTimeString() : 'Up to date'}
                  </div>
                </div>

                <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase' }}>Auto-Sync Worker</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: syncStatus?.auto_sync_worker_active !== false ? '#2E7D32' : '#999', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>{syncStatus?.auto_sync_worker_active !== false ? '⚡' : '⏸️'}</span>
                    <span>{syncStatus?.auto_sync_worker_active !== false ? 'Active (20s)' : 'Paused'}</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>Automatic daemon</div>
                </div>

                <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: '#777', fontWeight: 600, textTransform: 'uppercase' }}>Network Connection</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: syncStatus?.last_sync_status === 'OFFLINE' ? '#C62828' : '#2E7D32', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>{syncStatus?.last_sync_status === 'OFFLINE' ? '🔴' : '🟢'}</span>
                    <span>{syncStatus?.last_sync_status === 'OFFLINE' ? 'Offline' : 'Connected'}</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#888', marginTop: 4 }}>
                    {syncStatus?.last_sync_timestamp ? `Last: ${new Date(syncStatus.last_sync_timestamp).toLocaleTimeString()}` : 'No sync recorded'}
                  </div>
                </div>
              </div>
            </div>

            {/* 2. Branch Identity Configuration Form */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24, marginBottom: 24 }}>
              <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 20 }}>
                <h3 style={{ fontSize: 14, margin: '0 0 12px 0', color: '#8B1E2D', fontWeight: 800 }}>
                  🏢 Persistent Branch & Terminal Identity Configuration
                </h3>
                <p style={{ fontSize: 12, color: '#666', margin: '0 0 16px 0' }}>
                  Configure this Windows POS machine's unique identity. Do not configure two branch locations with the same branch ID.
                </p>

                <form onSubmit={handleSaveBranchConfig}>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 6 }}>
                      ⚡ 1-Click Branch Quick Presets:
                    </label>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <button
                        type="button"
                        onClick={() => {
                          setSyncConfigForm({
                            ...syncConfigForm,
                            branch_id: 'IB',
                            branch_name: 'Iyer Bungalow Branch (IB)',
                          });
                        }}
                        style={{
                          padding: '10px 12px',
                          backgroundColor: syncConfigForm.branch_id === 'IB' ? '#8B1E2D' : '#F9F9F6',
                          color: syncConfigForm.branch_id === 'IB' ? '#fff' : '#1F1F1F',
                          border: syncConfigForm.branch_id === 'IB' ? '2px solid #8B1E2D' : '1px solid #D5D5CE',
                          borderRadius: 8,
                          cursor: 'pointer',
                          fontWeight: 700,
                          fontSize: 12,
                          textAlign: 'left',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <span style={{ fontSize: 13 }}>📍 Branch 1: Iyer Bungalow</span>
                        <span style={{ fontSize: 10, opacity: syncConfigForm.branch_id === 'IB' ? 0.85 : 0.6 }}>ID: IB • Natham Main Road</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setSyncConfigForm({
                            ...syncConfigForm,
                            branch_id: 'UK',
                            branch_name: 'Umachikulam Branch (UK)',
                          });
                        }}
                        style={{
                          padding: '10px 12px',
                          backgroundColor: syncConfigForm.branch_id === 'UK' ? '#8B1E2D' : '#F9F9F6',
                          color: syncConfigForm.branch_id === 'UK' ? '#fff' : '#1F1F1F',
                          border: syncConfigForm.branch_id === 'UK' ? '2px solid #8B1E2D' : '1px solid #D5D5CE',
                          borderRadius: 8,
                          cursor: 'pointer',
                          fontWeight: 700,
                          fontSize: 12,
                          textAlign: 'left',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <span style={{ fontSize: 13 }}>📍 Branch 2: Umachikulam</span>
                        <span style={{ fontSize: 10, opacity: syncConfigForm.branch_id === 'UK' ? 0.85 : 0.6 }}>ID: UK • Main Road</span>
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 4 }}>
                        Branch ID Code *
                      </label>
                      <input
                        type="text"
                        value={syncConfigForm.branch_id}
                        onChange={e => setSyncConfigForm({ ...syncConfigForm, branch_id: e.target.value.toUpperCase() })}
                        required
                        placeholder="e.g. IB or UK"
                        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', fontWeight: 700 }}
                      />
                      <span style={{ fontSize: 11, color: '#777' }}>IB = Iyer Bungalow, UK = Umachikulam</span>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 4 }}>
                        Terminal ID *
                      </label>
                      <input
                        type="text"
                        value={syncConfigForm.terminal_id}
                        onChange={e => setSyncConfigForm({ ...syncConfigForm, terminal_id: e.target.value.toUpperCase() })}
                        required
                        placeholder="e.g. T1 or T2"
                        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                      />
                      <span style={{ fontSize: 11, color: '#777' }}>Physical POS machine identifier</span>
                    </div>
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 4 }}>
                      Branch Store Name *
                    </label>
                    <input
                      type="text"
                      value={syncConfigForm.branch_name}
                      onChange={e => setSyncConfigForm({ ...syncConfigForm, branch_name: e.target.value })}
                      required
                      placeholder="e.g. Iyer Bungalow Branch (IB)"
                      style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                    />
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14, marginBottom: 14 }}>
                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 4 }}>
                        Central Cloud API Endpoint *
                      </label>
                      <input
                        type="text"
                        value={syncConfigForm.cloud_api_url}
                        onChange={e => setSyncConfigForm({ ...syncConfigForm, cloud_api_url: e.target.value })}
                        required
                        placeholder="http://127.0.0.1:3000"
                        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace' }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 4 }}>
                        Counter Code
                      </label>
                      <input
                        type="text"
                        value={syncConfigForm.counter_id}
                        onChange={e => setSyncConfigForm({ ...syncConfigForm, counter_id: e.target.value })}
                        required
                        placeholder="C1"
                        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>

                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 4 }}>
                      Cloud API Authorization Key *
                    </label>
                    <input
                      type="password"
                      value={syncConfigForm.cloud_api_key}
                      onChange={e => setSyncConfigForm({ ...syncConfigForm, cloud_api_key: e.target.value })}
                      required
                      style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace' }}
                    />
                    <span style={{ fontSize: 11, color: '#777' }}>Bearer token for authenticating batch uploads</span>
                  </div>

                  <div style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      id="auto_sync_cb"
                      checked={syncConfigForm.auto_sync_enabled}
                      onChange={e => setSyncConfigForm({ ...syncConfigForm, auto_sync_enabled: e.target.checked })}
                      style={{ width: 16, height: 16, cursor: 'pointer' }}
                    />
                    <label htmlFor="auto_sync_cb" style={{ fontSize: 13, color: '#333', fontWeight: 600, cursor: 'pointer' }}>
                      Enable automated periodic sync in background (every 30s)
                    </label>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <button
                      type="submit"
                      disabled={isSavingBranchConfig}
                      style={{
                        padding: '11px 22px',
                        backgroundColor: branchConfigSavedSuccess ? '#2E7D32' : isSavingBranchConfig ? '#7A1A28' : '#8B1E2D',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 7,
                        fontSize: 13,
                        fontWeight: 700,
                        cursor: isSavingBranchConfig ? 'wait' : 'pointer',
                        opacity: isSavingBranchConfig ? 0.72 : 1,
                        filter: isSavingBranchConfig ? 'blur(0.8px)' : 'none',
                        transform: isSavingBranchConfig ? 'scale(0.98)' : 'scale(1)',
                        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 8,
                        boxShadow: isSavingBranchConfig ? 'none' : '0 2px 6px rgba(139,30,45,0.22)',
                      }}
                    >
                      {isSavingBranchConfig ? (
                        <>
                          <span style={{ display: 'inline-block' }}>⏳</span>
                          <span>Saving Configuration...</span>
                        </>
                      ) : branchConfigSavedSuccess ? (
                        <>
                          <span>✅</span>
                          <span>Configuration Saved!</span>
                        </>
                      ) : (
                        <>
                          <span>💾</span>
                          <span>Save Branch Identity Configuration</span>
                        </>
                      )}
                    </button>

                    {branchConfigSavedSuccess && (
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          backgroundColor: '#E8F5E9',
                          border: '1px solid #A5D6A7',
                          borderRadius: 6,
                          padding: '6px 12px',
                          fontSize: 12,
                          color: '#1B5E20',
                          fontWeight: 700,
                        }}
                      >
                        <span>🏢 Active:</span>
                        <span>{syncConfigForm.branch_id} — {syncConfigForm.branch_name}</span>
                      </div>
                    )}
                  </div>
                </form>
              </div>

              {/* 3. Architectural Safeguards Info Panel */}
              <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 20 }}>
                <h3 style={{ fontSize: 14, margin: '0 0 12px 0', color: '#6F1623', fontWeight: 800 }}>
                  🛡️ Malgudi Multi-Branch Isolation Safeguards
                </h3>
                
                <div style={{ fontSize: 12, color: '#444', lineHeight: 1.6 }}>
                  <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid #EFE4D8' }}>
                    <strong style={{ color: '#8B1E2D' }}>1. Sovereign Offline Operation:</strong><br/>
                    Each branch maintains a local SQLite database with write-ahead logging (WAL). Sales, GST invoices, and stock reductions never stall when broadband drops.
                  </div>

                  <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid #EFE4D8' }}>
                    <strong style={{ color: '#8B1E2D' }}>2. Partitioned Series Sequences:</strong><br/>
                    Branch <strong>IB</strong> issues series <code style={{ backgroundColor: '#eee', padding: '1px 4px', borderRadius: 3 }}>IB1/2627/000001</code> while Branch <strong>MN</strong> issues <code style={{ backgroundColor: '#eee', padding: '1px 4px', borderRadius: 3 }}>MN1/2627/000001</code>. Sequence collisions are mathematically impossible.
                  </div>

                  <div style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid #EFE4D8' }}>
                    <strong style={{ color: '#8B1E2D' }}>3. Durable Outbox & Restart Safety:</strong><br/>
                    Every transaction writes to <code style={{ backgroundColor: '#eee', padding: '1px 4px', borderRadius: 3 }}>sync_outbox</code> within the same ACID commit as the sale. If the Windows PC reboots or crashes, unacknowledged records remain pending.
                  </div>

                  <div>
                    <strong style={{ color: '#8B1E2D' }}>4. Idempotency & Tamper Protection:</strong><br/>
                    Central API computes SHA-256 payload hashes. Replaying lost ACKs is completely safe, while payload tampering triggers automatic HTTP 409 conflict rejection.
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 6: SOFTWARE UPDATES & OTA DEPLOYMENT */}
        {ownerSubTab === 'updates' && (
          <div>
            {/* Header & Quick Action */}
            <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 20, marginBottom: 24 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                <div>
                  <h3 style={{ fontSize: 16, margin: 0, color: '#8B1E2D', fontWeight: 800, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>🔄</span> Software Updates & Over-The-Air (OTA) Deployment
                  </h3>
                  <p style={{ fontSize: 12, color: '#666', margin: '4px 0 0 0' }}>
                    Cryptographically signed desktop updates for counter terminals. Changes download securely and relaunch with zero loss of offline sales or customer tabs.
                  </p>
                </div>

                <button
                  onClick={() => handleCheckForUpdates(false)}
                  disabled={isCheckingUpdate || isUpdating}
                  style={{
                    padding: '10px 18px',
                    backgroundColor: isCheckingUpdate ? '#7A1A28' : '#8B1E2D',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: isCheckingUpdate || isUpdating ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    boxShadow: '0 2px 6px rgba(139,30,45,0.25)',
                    opacity: isCheckingUpdate || isUpdating ? 0.75 : 1,
                  }}
                >
                  <span>{isCheckingUpdate ? '⏳' : '🔄'}</span>
                  <span>{isCheckingUpdate ? 'Checking GitHub Releases...' : 'Check for Updates Now'}</span>
                </button>
              </div>

              {/* Status Alert Messages */}
              {updateErrorMessage && (
                <div style={{ marginTop: 16, backgroundColor: '#FFEBEE', border: '1px solid #FFCDD2', color: '#C62828', padding: '12px 16px', borderRadius: 6, fontSize: 13 }}>
                  <div style={{ fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>⚠️</span> Update Server Warning
                  </div>
                  <div>{updateErrorMessage}</div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                    Cashier billing operates normally in offline mode. Software updates require an active internet connection.
                  </div>
                </div>
              )}

              {updateStatusMessage && !updateErrorMessage && !availableUpdate && (
                <div style={{ marginTop: 16, backgroundColor: '#E8F5E9', border: '1px solid #C8E6C9', color: '#2E7D32', padding: '12px 16px', borderRadius: 6, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 16 }}>✓</span>
                  <span>{updateStatusMessage}</span>
                </div>
              )}

              {/* Available Update Card */}
              {availableUpdate && (
                <div style={{ marginTop: 16, backgroundColor: '#FFFBEB', border: '1px solid #F59E0B', borderRadius: 8, padding: 18 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 20 }}>🚀</span>
                        <h4 style={{ margin: 0, fontSize: 16, color: '#92400E', fontWeight: 800 }}>
                          New Version Available: v{availableUpdate.version}
                        </h4>
                        <span style={{ backgroundColor: '#FEF3C7', color: '#B45309', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, border: '1px solid #FDE68A' }}>
                          Signed & Verified
                        </span>
                      </div>
                      <div style={{ fontSize: 12, color: '#78350F', marginTop: 6 }}>
                        Current Version: <strong>v{currentAppVersion}</strong> | Published: {availableUpdate.date ? new Date(availableUpdate.date).toLocaleDateString() : 'Latest'}
                      </div>
                      {availableUpdate.body && (
                        <div style={{ marginTop: 10, backgroundColor: '#FEF3C7', padding: '10px 14px', borderRadius: 6, fontSize: 12, color: '#78350F', whiteSpace: 'pre-line', border: '1px solid #FDE68A', maxHeight: 120, overflowY: 'auto' }}>
                          <strong style={{ display: 'block', marginBottom: 4 }}>Release Notes:</strong>
                          {availableUpdate.body}
                        </div>
                      )}
                    </div>

                    <div style={{ minWidth: 220 }}>
                      {isUpdating ? (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#92400E', marginBottom: 6 }}>
                            {updateStatusMessage || 'Downloading update...'}
                          </div>
                          <div style={{ width: '100%', height: 10, backgroundColor: '#FDE68A', borderRadius: 5, overflow: 'hidden' }}>
                            <div style={{ width: `${updateProgressPercent}%`, height: '100%', backgroundColor: '#D97706', transition: 'width 0.2s' }} />
                          </div>
                          <div style={{ fontSize: 11, color: '#B45309', textAlign: 'right', marginTop: 4, fontWeight: 700 }}>
                            {updateProgressPercent}% Completed
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={handleApplyUpdate}
                          style={{
                            width: '100%',
                            padding: '12px 18px',
                            backgroundColor: '#D97706',
                            color: '#fff',
                            border: 'none',
                            borderRadius: 6,
                            fontWeight: 700,
                            fontSize: 13,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 8,
                            boxShadow: '0 2px 6px rgba(217,119,6,0.3)',
                          }}
                        >
                          <span>⚡</span>
                          <span>Download, Install & Relaunch</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Architecture & Verification Tiles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
              <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#8B1E2D', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span>🔐</span> Cryptographic Signing
                </div>
                <div style={{ fontSize: 12, color: '#555', lineHeight: 1.5 }}>
                  Every Windows executable is signed with an asymmetric Ed25519 private key. The desktop POS verifies the signature against the embedded public key (<code style={{ backgroundColor: '#eee', padding: '1px 4px', borderRadius: 3 }}>2BCE14FA4599BEAE</code>) before installing.
                </div>
              </div>

              <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#8B1E2D', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span>🛡️</span> Zero Data Loss Guarantee
                </div>
                <div style={{ fontSize: 12, color: '#555', lineHeight: 1.5 }}>
                  Updating the app replaces only the binary executable. Local SQLite database (<code style={{ backgroundColor: '#eee', padding: '1px 4px', borderRadius: 3 }}>malgudi.db</code>), outbox queue, products, and offline receipts are 100% persistent and untouched.
                </div>
              </div>

              <div style={{ backgroundColor: '#fff', border: '1px solid #E2E2DC', borderRadius: 8, padding: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 800, color: '#8B1E2D', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <span>🌐</span> GitHub Releases Channel
                </div>
                <div style={{ fontSize: 12, color: '#555', lineHeight: 1.5 }}>
                  Endpoints point directly to GitHub Release assets via <code style={{ backgroundColor: '#eee', padding: '1px 4px', borderRadius: 3 }}>latest.json</code>. Terminal cashiers never need to download manual zip files or touch setup wizards.
                </div>
              </div>
            </div>

            {/* Version Information Details */}
            <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 8, padding: 18 }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: 14, color: '#8B1E2D', fontWeight: 800 }}>
                Terminal Software Identity
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, fontSize: 12 }}>
                <div>
                  <span style={{ color: '#777', display: 'block' }}>Current App Version:</span>
                  <strong style={{ color: '#8B1E2D', fontSize: 14 }}>v{currentAppVersion}</strong>
                </div>
                <div>
                  <span style={{ color: '#777', display: 'block' }}>Target Platform:</span>
                  <strong>Windows x86_64 (NSIS)</strong>
                </div>
                <div>
                  <span style={{ color: '#777', display: 'block' }}>Active Branch:</span>
                  <strong>{syncConfig?.branch_id || 'IB'} ({syncConfig?.branch_name || 'Iyer Bungalow'})</strong>
                </div>
                <div>
                  <span style={{ color: '#777', display: 'block' }}>Terminal Counter:</span>
                  <strong>{syncConfig?.terminal_id || 'T1'} / {syncConfig?.counter_id || 'C1'}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )}

      {/* 3. Main Desktop-First Two-Column POS Billing Screen */}
      {activeTab === 'billing' && (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          {/* ========================================================= */}
          {/* LEFT PANEL — PRODUCT CATALOG (~62% width)               */}
          {/* ========================================================= */}
          <div
            style={{
              flex: 1.6,
              display: 'flex',
              flexDirection: 'column',
              backgroundColor: '#F7F7F5',
              padding: '12px 16px',
              overflow: 'hidden',
              borderRight: '1px solid #E2E2DC',
            }}
          >
            {/* Top Search Bar */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#888' }}>
                  🔍
                </span>
                <input
                  type="text"
                  placeholder="Search sweet, savory, SKU, or Tamil name (e.g. Mysore, லட்டு, MP-001)..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 36px 10px 36px',
                    fontSize: 14,
                    border: '1px solid #D0D0CA',
                    borderRadius: 8,
                    backgroundColor: '#fff',
                    outline: 'none',
                    boxSizing: 'border-box',
                    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.03)',
                  }}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    style={{
                      position: 'absolute',
                      right: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      border: 'none',
                      background: 'none',
                      color: '#888',
                      cursor: 'pointer',
                      fontSize: 14,
                      fontWeight: 'bold',
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>

              <div style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap', fontWeight: 500 }}>
                {catalogLoading ? 'Refreshing catalog...' : <>Showing <strong>{filteredProducts.length}</strong> items</>}
              </div>
            </div>

            {/* Horizontal Category Filter Pills */}
            <div
              style={{
                display: 'flex',
                gap: 8,
                overflowX: 'auto',
                paddingBottom: 8,
                marginBottom: 8,
                flexShrink: 0,
              }}
            >
              {categories.map(cat => {
                const isActive = selectedCategory === cat.id;
                const count = cat.id === 'all' ? catalog.filter(p => p.is_active).length : catalog.filter(p => p.is_active && p.category_id === cat.id).length;
                return (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 20,
                      border: isActive ? '1px solid #8B1E2D' : '1px solid #D8D8D2',
                      backgroundColor: isActive ? '#8B1E2D' : '#FFFDF9',
                      color: isActive ? '#FFF9F0' : '#333',
                      fontSize: 13,
                      fontWeight: isActive ? 700 : 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      whiteSpace: 'nowrap',
                      boxShadow: isActive ? '0 2px 6px rgba(139,30,45,0.2)' : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <span>{cat.icon}</span>
                    <span>{cat.name}</span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 10,
                        backgroundColor: isActive ? '#6F1623' : '#EAEAE4',
                        color: isActive ? '#FFF9F0' : '#555',
                      }}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Responsive Product Cards Grid */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                paddingRight: 4,
              }}
            >
              {filteredProducts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: '#666' }}>
                  <span style={{ fontSize: 36, display: 'block', marginBottom: 8 }}>🔍</span>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>No products found</div>
                  <div style={{ fontSize: 13, marginTop: 4 }}>No items match "{searchQuery}" in this category.</div>
                  <button
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedCategory('all');
                    }}
                    style={{
                      marginTop: 14,
                      padding: '8px 16px',
                      backgroundColor: '#8B1E2D',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Clear Search & Filters
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                    gap: 12,
                    paddingBottom: 16,
                  }}
                >
                  {filteredProducts.map(product => {
                    const cartItem = cartItems.find(i => i.product_id === product.id);
                    const isInCart = !!cartItem;

                    return (
                      <div
                        key={product.id}
                        onClick={() => handleProductCardClick(product)}
                        style={{
                          backgroundColor: '#FFFDF9',
                          border: isInCart ? '2px solid #8B1E2D' : '1px solid #DEDEDA',
                          borderRadius: 10,
                          padding: 12,
                          cursor: 'pointer',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'space-between',
                          boxShadow: isInCart ? '0 4px 12px rgba(139,30,45,0.1)' : '0 2px 4px rgba(0,0,0,0.03)',
                          transition: 'transform 0.1s ease, box-shadow 0.1s ease',
                          position: 'relative',
                        }}
                      >
                        {/* Top: SKU & Badge (No Emoji) */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#888', letterSpacing: 0.5, fontFamily: 'monospace' }}>
                            {product.sku}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: 4,
                              backgroundColor: product.pricing_unit === 'PER_KG' ? '#FFF3E0' : '#E8F5E9',
                              color: product.pricing_unit === 'PER_KG' ? '#E65100' : '#2E7D32',
                              letterSpacing: 0.3,
                            }}
                          >
                            {product.pricing_unit === 'PER_KG' ? 'SCALE / WT' : 'UNIT / PC'}
                          </span>
                        </div>

                        {/* Name & Tamil Name */}
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14, color: '#1F1F1F', lineHeight: 1.25, marginBottom: 2 }}>
                            {product.name}
                          </div>
                          {product.tamil_name && product.tamil_name.trim() !== '' && product.tamil_name.trim().toLowerCase() !== product.name.trim().toLowerCase() && (
                            <div style={{ fontSize: 12, color: '#777', marginBottom: 8, fontStyle: 'normal' }}>
                              {product.tamil_name}
                            </div>
                          )}
                        </div>

                        {/* Bottom: Price, Tax & Live Stock Indicator */}
                        <div style={{ borderTop: '1px dashed #E5E5DF', paddingTop: 8, marginTop: 'auto' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <span style={{ fontSize: 16, fontWeight: 800, color: '#8B1E2D' }}>
                              ₹{(product.base_price_paise / 100).toFixed(0)}
                              <span style={{ fontSize: 11, fontWeight: 500, color: '#666' }}>
                                /{product.pricing_unit === 'PER_KG' ? 'kg' : 'pc'}
                              </span>
                            </span>
                            <span style={{ fontSize: 10, color: '#888' }}>
                              {product.tax_rate_bps / 100}% GST
                            </span>
                          </div>

                          {/* Live Branch Stock Indicator */}
                          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center' }}>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: product.current_stock <= 0 ? '#C62828' : (product.pricing_unit === 'PER_KG' ? product.current_stock < 5000000 : product.current_stock < 10) ? '#E65100' : '#2E7D32',
                              }}
                            >
                              {product.current_stock <= 0
                                ? '● Out of stock'
                                : product.pricing_unit === 'PER_KG'
                                ? `● ${(product.current_stock / 1000000).toFixed(2)} kg in stock`
                                : `● ${product.current_stock} ${product.stock_unit.toLowerCase()} in stock`}
                            </span>
                          </div>

                          {/* In-Cart Indicator */}
                          {isInCart && (
                            <div
                              style={{
                                marginTop: 6,
                                padding: '3px 6px',
                                backgroundColor: '#8B1E2D',
                                color: '#FFF9F0',
                                borderRadius: 4,
                                fontSize: 11,
                                fontWeight: 700,
                                textAlign: 'center',
                              }}
                            >
                              ✓ In Cart ({cartItem.pricing_unit === 'PER_KG' ? `${(cartItem.quantity_input / 1000).toFixed(0)}g` : `${cartItem.quantity_input} pcs`})
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ========================================================= */}
          {/* RIGHT PANEL — CURRENT ORDER / CART (~38% width)          */}
          {/* ========================================================= */}
          <div
            style={{
              width: 440,
              backgroundColor: '#FFFDF9',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '-2px 0 8px rgba(0,0,0,0.03)',
              overflow: 'hidden',
            }}
          >
            {/* Order Header */}
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #EBEBE6',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                backgroundColor: '#FFFDF9',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18 }}>🛒</span>
                <span style={{ fontWeight: 800, fontSize: 15, color: '#1F1F1F' }}>
                  Current Order
                </span>
                <span
                  style={{
                    backgroundColor: '#8B1E2D',
                    color: '#fff',
                    borderRadius: 12,
                    padding: '1px 8px',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {cartItems.length}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {!customerInfo ? (
                  <button
                    type="button"
                    onClick={() => {
                      setCustomerForm({ name: '', phone: '', location: '' });
                      setCustomerPhoneError(null);
                      setIsCustomerModalOpen(true);
                    }}
                    title="Add Customer Details (F2) - Optional"
                    style={{
                      padding: '4px 10px',
                      fontSize: 11,
                      fontWeight: 700,
                      borderRadius: 14,
                      border: '1px dashed #B8860B',
                      backgroundColor: '#FFFDF0',
                      color: '#8B1E2D',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <span>👤 + Customer</span>
                    <span style={{ fontSize: 9, opacity: 0.75, backgroundColor: '#EAD8C7', padding: '1px 4px', borderRadius: 3 }}>F2</span>
                  </button>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      backgroundColor: '#E8F5E9',
                      border: '1px solid #C8E6C9',
                      borderRadius: 14,
                      padding: '3px 8px 3px 10px',
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#2E7D32',
                    }}
                  >
                    <span
                      onClick={() => {
                        setCustomerForm({
                          name: customerInfo.name,
                          phone: customerInfo.phone,
                          location: customerInfo.location,
                        });
                        setCustomerPhoneError(null);
                        setIsCustomerModalOpen(true);
                      }}
                      style={{ cursor: 'pointer' }}
                      title="Click to edit customer details"
                    >
                      👤 {customerInfo.name || customerInfo.phone || 'Customer'}
                      {customerInfo.phone && <span style={{ opacity: 0.75, fontSize: 10, marginLeft: 4 }}>({customerInfo.phone})</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomerInfo(null);
                        setCustomerForm({ name: '', phone: '', location: '' });
                      }}
                      title="Remove customer (revert to walk-in)"
                      style={{
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        color: '#c62828',
                        fontSize: 12,
                        padding: 0,
                        marginLeft: 2,
                        lineHeight: 1,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}

                {cartItems.length > 0 && (
                  <button
                    onClick={handleClearCart}
                    style={{
                      border: 'none',
                      background: 'none',
                      color: '#c62828',
                      fontSize: 12,
                      cursor: 'pointer',
                      fontWeight: 600,
                    }}
                  >
                    Clear Order
                  </button>
                )}
              </div>
            </div>

            {/* Scrollable Cart Items List */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '8px 12px',
              }}
            >
              {cartItems.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '60px 20px', color: '#888' }}>
                  <span style={{ fontSize: 42, display: 'block', marginBottom: 10 }}>🛍️</span>
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#444' }}>Cart is empty</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>Tap any sweet, savory, or bakery item on the left to add to bill.</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {cartItems.map((item, idx) => {
                    const prod = catalog.find(p => p.id === item.product_id);
                    const name = prod?.name || item.product_id;
                    const tamilName = prod?.tamil_name || '';

                    return (
                      <div
                        key={idx}
                        style={{
                          backgroundColor: '#fff',
                          border: '1px solid #EAEAEA',
                          borderRadius: 8,
                          padding: 10,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.02)',
                        }}
                      >
                        {/* Title & Delete */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div
                            onClick={() => handleOpenItemEditModal(idx, item, prod)}
                            style={{ cursor: 'pointer', flex: 1 }}
                            title="Click to edit quantity or weight"
                          >
                            <div style={{ fontWeight: 700, fontSize: 13, color: '#1F1F1F' }}>
                              {name}
                            </div>
                            {tamilName && tamilName.trim() !== '' && tamilName.trim().toLowerCase() !== name.trim().toLowerCase() && (
                              <div style={{ fontSize: 11, color: '#777' }}>
                                {tamilName}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => handleRemoveCartItem(idx)}
                            style={{
                              border: 'none',
                              background: 'none',
                              color: '#999',
                              fontSize: 14,
                              cursor: 'pointer',
                              padding: '2px 4px',
                            }}
                            title="Remove item"
                          >
                            ✕
                          </button>
                        </div>

                        {/* Quantity / Weight Stepper & Line Price */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 }}>
                          {/* Stepper & Weight Input */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, backgroundColor: '#F5F5F0', padding: '3px 6px', borderRadius: 6 }}>
                            <button
                              onClick={() => handleAdjustCartItemQty(idx, -1)}
                              title="Decrease"
                              style={{
                                width: 24,
                                height: 24,
                                borderRadius: 4,
                                border: '1px solid #ccc',
                                backgroundColor: '#fff',
                                fontWeight: 'bold',
                                fontSize: 14,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              -
                            </button>

                            {item.pricing_unit === 'PER_KG' ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                                <input
                                  type="number"
                                  value={Math.round(item.quantity_input / 1000)}
                                  onChange={e => handleDirectWeightChange(idx, Number(e.target.value))}
                                  min={1}
                                  step="any"
                                  title="Directly edit grams using keyboard"
                                  style={{
                                    width: 52,
                                    padding: '2px 4px',
                                    fontSize: 12,
                                    fontWeight: 700,
                                    textAlign: 'center',
                                    border: '1px solid #ccc',
                                    borderRadius: 4,
                                    backgroundColor: '#fff',
                                    color: '#1F1F1F',
                                  }}
                                />
                                <button
                                  type="button"
                                  onClick={() => handleOpenItemEditModal(idx, item, prod)}
                                  style={{
                                    border: 'none',
                                    background: 'none',
                                    fontWeight: 700,
                                    fontSize: 11,
                                    color: '#8B1E2D',
                                    cursor: 'pointer',
                                    padding: '0 2px',
                                  }}
                                  title="Click to open weight keypad / presets (Switch g / kg)"
                                >
                                  g ⚖️
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handleOpenItemEditModal(idx, item, prod)}
                                style={{
                                  border: 'none',
                                  background: 'none',
                                  fontWeight: 700,
                                  fontSize: 12,
                                  color: '#8B1E2D',
                                  minWidth: 56,
                                  textAlign: 'center',
                                  cursor: 'pointer',
                                  padding: '2px 4px',
                                  borderRadius: 4,
                                  backgroundColor: '#fff',
                                }}
                                title="Click to open quantity keypad / presets"
                              >
                                {item.quantity_input} {item.pricing_unit === 'PER_PACK' ? 'pack' : 'pc'}
                              </button>
                            )}

                            <button
                              onClick={() => handleAdjustCartItemQty(idx, 1)}
                              title="Increase"
                              style={{
                                width: 24,
                                height: 24,
                                borderRadius: 4,
                                border: '1px solid #ccc',
                                backgroundColor: '#fff',
                                fontWeight: 'bold',
                                fontSize: 14,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              +
                            </button>
                          </div>

                          {/* Line Gross Total */}
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: 14, fontWeight: 800, color: '#8B1E2D' }}>
                              ₹{(item.gross_paise / 100).toFixed(2)}
                            </div>
                            <div style={{ fontSize: 10, color: '#888' }}>
                              ₹{(item.unit_price_paise / 100).toFixed(0)}/{item.pricing_unit === 'PER_KG' ? 'kg' : 'pc'}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Cart Error Notification */}
            {errorMessage && (
              <div style={{ margin: '0 12px 6px 12px', padding: '8px 10px', backgroundColor: '#ffebee', color: '#c62828', borderRadius: 6, fontSize: 12 }}>
                ⚠ {errorMessage}
              </div>
            )}

            {/* Bill Summary & Payment Trigger Footer */}
            <div
              style={{
                backgroundColor: '#FFF9F0',
                borderTop: '2px solid #EAD8C7',
                padding: '12px 16px',
                flexShrink: 0,
              }}
            >
              {/* Financial Totals */}
              <div style={{ fontSize: 12, color: '#666', display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Taxable Subtotal:</span>
                  <span>₹{(subtotalTaxablePaise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>CGST (2.5%) + SGST (2.5%):</span>
                  <span>₹{((totalCgstPaise + totalSgstPaise) / 100).toFixed(2)}</span>
                </div>
              </div>

              {/* Total Payable Box */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  borderTop: '1px solid #E5D5C5',
                  paddingTop: 8,
                  marginBottom: 12,
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 700, color: '#1F1F1F' }}>
                  Total Net Payable:
                </span>
                <span style={{ fontSize: 24, fontWeight: 900, color: '#8B1E2D' }}>
                  ₹{(totalGrossPaise / 100).toFixed(2)}
                </span>
              </div>

              {/* Live Cash Drawer Status Strip right above checkout buttons */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '5px 10px',
                  backgroundColor: liveDrawerSummary?.has_opening_float ? '#F0FDF4' : '#FFFBEB',
                  borderRadius: 6,
                  border: `1px solid ${liveDrawerSummary?.has_opening_float ? '#BBF7D0' : '#FDE68A'}`,
                  fontSize: 11,
                  color: liveDrawerSummary?.has_opening_float ? '#166534' : '#92400E',
                  marginBottom: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span>💵</span>
                  <span style={{ fontWeight: 600 }}>Drawer In-Hand:</span>
                </div>
                {liveDrawerSummary?.has_opening_float ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 800, fontSize: 12, color: '#14532D' }}>
                      ₹{(liveDrawerSummary.current_drawer_cash_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                    <span style={{ fontSize: 10, color: '#65A30D' }}>
                      (F: ₹{(liveDrawerSummary.opening_float_paise / 100).toLocaleString('en-IN')} + C: ₹{(liveDrawerSummary.cash_sales_paise / 100).toLocaleString('en-IN')})
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsOpeningFloatModalOpen(true)}
                    style={{
                      border: 'none',
                      background: 'none',
                      color: '#B45309',
                      fontWeight: 700,
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      fontSize: 11,
                      padding: 0,
                    }}
                  >
                    Set Starting Float →
                  </button>
                )}
              </div>

              {/* Action Buttons: Fast Retail Checkout */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Two Prominent Quick-Payment Buttons */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {/* 💵 Exact Cash */}
                  <button
                    onClick={handleExactCashSale}
                    disabled={cartItems.length === 0 || isFinalizing}
                    style={{
                      padding: '11px 8px',
                      backgroundColor: cartItems.length === 0 || isFinalizing ? '#ccc' : '#2E7D32',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      fontWeight: 800,
                      cursor: cartItems.length === 0 || isFinalizing ? 'not-allowed' : 'pointer',
                      boxShadow: cartItems.length > 0 && !isFinalizing ? '0 4px 10px rgba(46,125,50,0.25)' : 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 2,
                    }}
                    title="1-Tap Instant Exact Cash Checkout (Enter)"
                  >
                    <span style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>💵 Exact Cash</span>
                    <span style={{ fontSize: 13, fontWeight: 900 }}>₹{(totalGrossPaise / 100).toFixed(2)}</span>
                  </button>

                  {/* 📱 UPI / QR */}
                  <button
                    onClick={() => {
                      setUpiSimulatedVerified(false);
                      setIsUpiModalOpen(true);
                    }}
                    disabled={cartItems.length === 0 || isFinalizing}
                    style={{
                      padding: '11px 8px',
                      backgroundColor: cartItems.length === 0 || isFinalizing ? '#ccc' : '#1565C0',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 8,
                      fontWeight: 800,
                      cursor: cartItems.length === 0 || isFinalizing ? 'not-allowed' : 'pointer',
                      boxShadow: cartItems.length > 0 && !isFinalizing ? '0 4px 10px rgba(21,101,192,0.25)' : 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 2,
                    }}
                    title="Instant UPI Dynamic QR Payment"
                  >
                    <span style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 4 }}>📱 UPI / QR</span>
                    <span style={{ fontSize: 13, fontWeight: 900 }}>₹{(totalGrossPaise / 100).toFixed(2)}</span>
                  </button>
                </div>

                {/* Secondary Option: Split Payment / Change Calculator */}
                <button
                  onClick={openPaymentModal}
                  disabled={cartItems.length === 0 || isFinalizing}
                  style={{
                    padding: '10px 12px',
                    backgroundColor: '#fff',
                    color: '#8B1E2D',
                    border: '1.5px solid #8B1E2D',
                    borderRadius: 8,
                    fontWeight: 700,
                    fontSize: 13,
                    cursor: cartItems.length === 0 || isFinalizing ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                  title="Proceed to Payment & Split Tender or calculate change for custom cash note (F4)"
                >
                  <span>⚡ Proceed to Payment / Split</span>
                  <span>➜</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 1: Weight Entry Keypad Dialog (PER_KG items)        */}
      {/* ========================================================= */}
      {weightModalProduct && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1200,
            padding: 16,
          }}
        >
          <div
            style={{
              backgroundColor: '#FFF9F0',
              border: '2px solid #8B1E2D',
              borderRadius: 12,
              padding: 24,
              maxWidth: 420,
              width: '100%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            }}
          >
            {(() => {
              const isPerKg = weightModalProduct.pricing_unit === 'PER_KG';
              const unitLabel = isPerKg ? 'kg' : weightModalProduct.pricing_unit === 'PER_PACK' ? 'pack' : 'pc';

              return (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                    <div>
                      <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 18 }}>{weightModalProduct.name}</h3>
                      <div style={{ fontSize: 12, color: '#666' }}>
                        {weightModalProduct.tamil_name && weightModalProduct.tamil_name.trim() !== '' && weightModalProduct.tamil_name.trim().toLowerCase() !== weightModalProduct.name.trim().toLowerCase() ? `${weightModalProduct.tamil_name} • ` : ''}₹{(weightModalProduct.base_price_paise / 100).toFixed(0)}/{unitLabel}
                      </div>
                    </div>
                    <button
                      onClick={() => setWeightModalProduct(null)}
                      style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
                    >
                      ✕
                    </button>
                  </div>

                  {isPerKg ? (
                    <>
                      {/* Unit Selector Toggle (g vs kg) */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, backgroundColor: '#FFFDF9', padding: '6px 12px', borderRadius: 8, border: '1px solid #EAD8C7' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#6F1623' }}>Select Unit:</span>
                        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1.5px solid #8B1E2D' }}>
                          <button
                            type="button"
                            onClick={() => {
                              setWeightModalUnit('g');
                            }}
                            style={{
                              padding: '5px 14px',
                              fontSize: 12,
                              fontWeight: 700,
                              border: 'none',
                              backgroundColor: weightModalUnit === 'g' ? '#8B1E2D' : '#FFF9F0',
                              color: weightModalUnit === 'g' ? '#fff' : '#8B1E2D',
                              cursor: 'pointer',
                            }}
                          >
                            Grams (g)
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setWeightModalUnit('kg');
                              setWeightModalKgInput((weightModalGrams / 1000).toString());
                            }}
                            style={{
                              padding: '5px 14px',
                              fontSize: 12,
                              fontWeight: 700,
                              border: 'none',
                              backgroundColor: weightModalUnit === 'kg' ? '#8B1E2D' : '#FFF9F0',
                              color: weightModalUnit === 'kg' ? '#fff' : '#8B1E2D',
                              cursor: 'pointer',
                            }}
                          >
                            Kilograms (kg)
                          </button>
                        </div>
                      </div>

                      {/* Quick Weight Chips */}
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 'bold', color: '#555', marginBottom: 6 }}>QUICK WEIGHT PRESETS</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                          {(weightModalUnit === 'kg'
                            ? [
                                { label: '0.1 kg (100g)', g: 100, kg: '0.1' },
                                { label: '0.25 kg (250g)', g: 250, kg: '0.25' },
                                { label: '0.5 kg (500g)', g: 500, kg: '0.5' },
                                { label: '0.75 kg (750g)', g: 750, kg: '0.75' },
                                { label: '1.0 kg', g: 1000, kg: '1' },
                                { label: '2.0 kg', g: 2000, kg: '2' },
                              ]
                            : [
                                { label: '100 g', g: 100, kg: '0.1' },
                                { label: '250 g', g: 250, kg: '0.25' },
                                { label: '375 g', g: 375, kg: '0.375' },
                                { label: '500 g', g: 500, kg: '0.5' },
                                { label: '750 g', g: 750, kg: '0.75' },
                                { label: '1000 g (1kg)', g: 1000, kg: '1' },
                              ]
                          ).map(p => (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => {
                                setWeightModalGrams(p.g);
                                setWeightModalKgInput(p.kg);
                              }}
                              style={{
                                padding: '8px 4px',
                                borderRadius: 6,
                                border: weightModalGrams === p.g ? '2px solid #8B1E2D' : '1px solid #ccc',
                                backgroundColor: weightModalGrams === p.g ? '#8B1E2D' : '#fff',
                                color: weightModalGrams === p.g ? '#fff' : '#1F1F1F',
                                fontWeight: 'bold',
                                fontSize: 12,
                                cursor: 'pointer',
                              }}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Weight Display & Live Calculated Total */}
                      <div
                        style={{
                          backgroundColor: '#fff',
                          border: '1.5px solid #8B1E2D',
                          borderRadius: 8,
                          padding: '10px 14px',
                          marginBottom: 14,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div>
                          <span style={{ fontSize: 11, color: '#666', display: 'block', fontWeight: 600 }}>
                            {weightModalUnit === 'kg' ? 'WEIGHT (TYPE IN KG)' : 'WEIGHT (TYPE IN GRAMS)'}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                            {weightModalUnit === 'kg' ? (
                              <input
                                type="number"
                                step="any"
                                min="0"
                                value={weightModalKgInput}
                                onChange={e => {
                                  const val = e.target.value;
                                  setWeightModalKgInput(val);
                                  const num = parseFloat(val) || 0;
                                  setWeightModalGrams(Math.round(num * 1000));
                                }}
                                autoFocus
                                placeholder="0.0"
                                style={{
                                  width: 110,
                                  padding: '4px 8px',
                                  fontSize: 20,
                                  fontWeight: 900,
                                  color: '#1F1F1F',
                                  border: '1.5px solid #8B1E2D',
                                  borderRadius: 6,
                                }}
                              />
                            ) : (
                              <input
                                type="number"
                                step="1"
                                value={weightModalGrams || ''}
                                onChange={e => {
                                  const g = Math.max(0, parseInt(e.target.value, 10) || 0);
                                  setWeightModalGrams(g);
                                  setWeightModalKgInput((g / 1000).toString());
                                }}
                                autoFocus
                                placeholder="0"
                                style={{
                                  width: 110,
                                  padding: '4px 8px',
                                  fontSize: 20,
                                  fontWeight: 900,
                                  color: '#1F1F1F',
                                  border: '1.5px solid #8B1E2D',
                                  borderRadius: 6,
                                }}
                              />
                            )}
                            <span style={{ fontSize: 16, fontWeight: 800, color: '#8B1E2D' }}>
                              {weightModalUnit === 'kg' ? 'kg' : 'grams'}
                            </span>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ fontSize: 11, color: '#666', display: 'block' }}>LINE TOTAL</span>
                          <span style={{ fontSize: 20, fontWeight: 900, color: '#8B1E2D' }}>
                            ₹{((weightModalProduct.base_price_paise * (weightModalGrams / 1000)) / 100).toFixed(2)}
                          </span>
                          <span style={{ fontSize: 11, color: '#888', display: 'block' }}>
                            {weightModalUnit === 'kg' ? `${weightModalGrams} g` : `${(weightModalGrams / 1000).toFixed(3)} kg`}
                          </span>
                        </div>
                      </div>

                      {/* Numeric Keypad for Custom Weight */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 16 }}>
                        {['1', '2', '3', '4', '5', '6', '7', '8', '9', weightModalUnit === 'kg' ? '.' : 'C', '0', '⌫'].map(k => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => {
                              if (k === 'C') {
                                setWeightModalGrams(0);
                                setWeightModalKgInput('0');
                              } else if (k === '⌫') {
                                if (weightModalUnit === 'kg') {
                                  const next = weightModalKgInput.length > 1 ? weightModalKgInput.slice(0, -1) : '0';
                                  setWeightModalKgInput(next);
                                  setWeightModalGrams(Math.round((parseFloat(next) || 0) * 1000));
                                } else {
                                  const g = Math.floor(weightModalGrams / 10);
                                  setWeightModalGrams(g);
                                  setWeightModalKgInput((g / 1000).toString());
                                }
                              } else if (k === '.') {
                                if (weightModalUnit === 'kg' && !weightModalKgInput.includes('.')) {
                                  setWeightModalKgInput(prev => (prev === '0' || prev === '' ? '0.' : prev + '.'));
                                }
                              } else {
                                // Digit
                                if (weightModalUnit === 'kg') {
                                  const next = weightModalKgInput === '0' ? k : weightModalKgInput + k;
                                  setWeightModalKgInput(next);
                                  setWeightModalGrams(Math.round((parseFloat(next) || 0) * 1000));
                                } else {
                                  const g = parseInt(`${weightModalGrams}${k}`, 10) || parseInt(k, 10);
                                  setWeightModalGrams(g);
                                  setWeightModalKgInput((g / 1000).toString());
                                }
                              }
                            }}
                            style={{
                              padding: '10px',
                              fontSize: 16,
                              fontWeight: 'bold',
                              backgroundColor: '#fff',
                              border: '1px solid #ddd',
                              borderRadius: 6,
                              cursor: 'pointer',
                            }}
                          >
                            {k}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      {/* Quick Quantity Chips for Unit/Pack items */}
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, fontWeight: 'bold', color: '#555', marginBottom: 6 }}>QUICK QUANTITY PRESETS</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                          {[
                            { label: '1 pc', val: 1 },
                            { label: '2 pcs', val: 2 },
                            { label: '3 pcs', val: 3 },
                            { label: '5 pcs', val: 5 },
                            { label: '10 pcs', val: 10 },
                            { label: '20 pcs', val: 20 },
                          ].map(p => (
                            <button
                              key={p.label}
                              type="button"
                              onClick={() => {
                                setWeightModalGrams(p.val);
                                setWeightModalKgInput(p.val.toString());
                              }}
                              style={{
                                padding: '8px 4px',
                                borderRadius: 6,
                                border: weightModalGrams === p.val ? '2px solid #8B1E2D' : '1px solid #ccc',
                                backgroundColor: weightModalGrams === p.val ? '#8B1E2D' : '#fff',
                                color: weightModalGrams === p.val ? '#fff' : '#1F1F1F',
                                fontWeight: 'bold',
                                fontSize: 12,
                                cursor: 'pointer',
                              }}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Quantity Display & Live Calculated Total */}
                      <div
                        style={{
                          backgroundColor: '#fff',
                          border: '1.5px solid #8B1E2D',
                          borderRadius: 8,
                          padding: '10px 14px',
                          marginBottom: 14,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div>
                          <span style={{ fontSize: 11, color: '#666', display: 'block', fontWeight: 600 }}>
                            QUANTITY ({weightModalProduct.pricing_unit === 'PER_PACK' ? 'PACKS' : 'PIECES'})
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                            <input
                              type="number"
                              step="1"
                              min="1"
                              value={weightModalGrams || ''}
                              onChange={e => {
                                const qty = Math.max(0, parseInt(e.target.value, 10) || 0);
                                setWeightModalGrams(qty);
                                setWeightModalKgInput(qty.toString());
                              }}
                              autoFocus
                              placeholder="0"
                              style={{
                                width: 110,
                                padding: '4px 8px',
                                fontSize: 20,
                                fontWeight: 900,
                                color: '#1F1F1F',
                                border: '1.5px solid #8B1E2D',
                                borderRadius: 6,
                              }}
                            />
                            <span style={{ fontSize: 16, fontWeight: 800, color: '#8B1E2D' }}>
                              {weightModalProduct.pricing_unit === 'PER_PACK' ? 'pack(s)' : 'pc(s)'}
                            </span>
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ fontSize: 11, color: '#666', display: 'block' }}>LINE TOTAL</span>
                          <span style={{ fontSize: 20, fontWeight: 900, color: '#8B1E2D' }}>
                            ₹{((weightModalProduct.base_price_paise * weightModalGrams) / 100).toFixed(2)}
                          </span>
                          <span style={{ fontSize: 11, color: '#888', display: 'block' }}>
                            {weightModalGrams} {weightModalProduct.pricing_unit === 'PER_PACK' ? 'pack(s)' : 'pc(s)'}
                          </span>
                        </div>
                      </div>

                      {/* Numeric Keypad for Custom Quantity */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginBottom: 16 }}>
                        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(k => (
                          <button
                            key={k}
                            type="button"
                            onClick={() => {
                              if (k === 'C') {
                                setWeightModalGrams(0);
                                setWeightModalKgInput('0');
                              } else if (k === '⌫') {
                                const qty = Math.floor(weightModalGrams / 10);
                                setWeightModalGrams(qty);
                                setWeightModalKgInput(qty.toString());
                              } else {
                                const qty = parseInt(`${weightModalGrams}${k}`, 10) || parseInt(k, 10);
                                setWeightModalGrams(qty);
                                setWeightModalKgInput(qty.toString());
                              }
                            }}
                            style={{
                              padding: '10px',
                              fontSize: 16,
                              fontWeight: 'bold',
                              backgroundColor: '#fff',
                              border: '1px solid #ddd',
                              borderRadius: 6,
                              cursor: 'pointer',
                            }}
                          >
                            {k}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {/* Modal Actions */}
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      type="button"
                      onClick={handleWeightModalSubmit}
                      disabled={weightModalGrams <= 0}
                      style={{
                        flex: 1,
                        padding: '12px',
                        backgroundColor: weightModalGrams > 0 ? '#8B1E2D' : '#ccc',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 6,
                        fontWeight: 'bold',
                        fontSize: 15,
                        cursor: weightModalGrams > 0 ? 'pointer' : 'not-allowed',
                      }}
                    >
                      {weightModalCartIndex !== null
                        ? (isPerKg ? 'Update Weight' : 'Update Quantity')
                        : '+ Add to Order'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setWeightModalProduct(null)}
                      style={{
                        padding: '12px 18px',
                        backgroundColor: '#ddd',
                        border: 'none',
                        borderRadius: 6,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 2: Focused Payment & Tender Reconciliation Modal    */}
      {/* ========================================================= */}
      {isPaymentModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: 16,
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              border: '2px solid #8B1E2D',
              borderRadius: 12,
              padding: 24,
              maxWidth: 540,
              width: '100%',
              boxShadow: '0 12px 36px rgba(0,0,0,0.25)',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid #eee', paddingBottom: 10 }}>
              <div>
                <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 18 }}>
                  ⚡ Split Payment & Change Calculator
                </h3>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                  Terminal {currentSession.branch_id}/{currentSession.terminal_id} • Counter {currentSession.counter_id}
                </div>
              </div>
              <button
                onClick={() => setIsPaymentModalOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
              >
                ✕
              </button>
            </div>

            {/* Bill Net Payable Banner */}
            <div
              style={{
                backgroundColor: '#FFF9F0',
                border: '1px solid #EAD8C7',
                borderRadius: 8,
                padding: '12px 16px',
                marginBottom: 16,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <span style={{ fontSize: 12, color: '#666', display: 'block' }}>ITEMS IN CART: {cartItems.length}</span>
                <span style={{ fontSize: 11, color: '#888' }}>
                  Subtotal: ₹{(subtotalTaxablePaise / 100).toFixed(2)} | GST: ₹{((totalCgstPaise + totalSgstPaise) / 100).toFixed(2)}
                </span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 11, color: '#8B1E2D', fontWeight: 'bold' }}>NET PAYABLE</span>
                <div style={{ fontSize: 26, fontWeight: 900, color: '#8B1E2D' }}>
                  ₹{(totalGrossPaise / 100).toFixed(2)}
                </div>
              </div>
            </div>

            {/* Cash Received Input & Automatic Change Calculation */}
            <div style={{ backgroundColor: '#FDFDFD', border: '1px solid #E5E5E0', borderRadius: 8, padding: 14, marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', marginBottom: 6, color: '#1F1F1F' }}>
                💵 Cash Received from Customer (₹)
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={cashTenderedRupees}
                onChange={e => setCashTenderedRupees(Number(e.target.value))}
                style={{ width: '100%', padding: '10px 12px', fontSize: 18, fontWeight: 'bold', borderRadius: 6, border: '1.5px solid #8B1E2D', boxSizing: 'border-box', marginBottom: 8 }}
              />

              {/* Quick Cash Note Presets */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                {[
                  { label: `Exact ₹${(totalGrossPaise / 100).toFixed(2)}`, val: totalGrossPaise / 100 },
                  { label: '₹100', val: 100 },
                  { label: '₹200', val: 200 },
                  { label: '₹500', val: 500 },
                  { label: '₹2000', val: 2000 },
                ].map(p => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setCashTenderedRupees(p.val)}
                    style={{ padding: '4px 10px', fontSize: 12, fontWeight: 600, backgroundColor: cashTenderedRupees === p.val ? '#FFF9F0' : '#f0f0f0', border: cashTenderedRupees === p.val ? '1.5px solid #8B1E2D' : '1px solid #ccc', color: cashTenderedRupees === p.val ? '#8B1E2D' : '#333', borderRadius: 4, cursor: 'pointer' }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Automatic Change & Drawer Status */}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, backgroundColor: '#FFF9F0', border: '1px solid #EAD8C7', padding: '10px 12px', borderRadius: 6 }}>
                <span>Change to Return: <strong style={{ color: changeReturnedPaise > 0 ? '#2E7D32' : '#666', fontSize: 14 }}>₹{(changeReturnedPaise / 100).toFixed(2)}</strong></span>
                <span>Physical Cash In Drawer: <strong style={{ color: '#8B1E2D' }}>₹{derivedCashAllocatedRupees.toFixed(2)}</strong></span>
              </div>
            </div>

            {/* Optional UPI Split Allocation */}
            <div style={{ backgroundColor: '#FDFDFD', border: '1px solid #E5E5E0', borderRadius: 8, padding: 14, marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontWeight: 'bold', fontSize: 12, color: '#333' }}>
                  📱 UPI Amount (Optional for Split Payment)
                </span>
                <span style={{ fontSize: 11, color: '#666', backgroundColor: '#f0f0f0', padding: '2px 6px', borderRadius: 4 }}>
                  Policy: {settlementPolicy === 'STRICT_GATEWAY_ONLY' ? 'Gateway Webhook' : 'Soundbox Audio'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="number"
                  step="any"
                  min="0"
                  placeholder="0"
                  value={upiAllocatedRupees}
                  onChange={e => setUpiAllocatedRupees(Number(e.target.value))}
                  style={{ flex: 1, padding: '8px 10px', fontSize: 15, fontWeight: 'bold', borderRadius: 6, border: '1px solid #ccc', boxSizing: 'border-box' }}
                />
                <button
                  type="button"
                  onClick={() => setUpiAllocatedRupees(0)}
                  style={{ padding: '8px 12px', fontSize: 12, backgroundColor: '#f5f5f5', border: '1px solid #ccc', borderRadius: 6, cursor: 'pointer' }}
                >
                  Clear UPI
                </button>
              </div>
            </div>

            {/* Split Tender Balance Status */}
            {(() => {
              const allocatedTotalPaise = derivedCashAllocatedPaise + Math.round(upiAllocatedRupees * 100);
              const diffPaise = totalGrossPaise - allocatedTotalPaise;
              const isBalanced = diffPaise === 0;

              return (
                <div
                  style={{
                    padding: 8,
                    borderRadius: 6,
                    marginBottom: 16,
                    fontSize: 12,
                    fontWeight: 'bold',
                    backgroundColor: isBalanced ? '#E8F5E9' : '#FFEBEE',
                    color: isBalanced ? '#2E7D32' : '#C62828',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <span>{isBalanced ? '✓ Tender Fully Reconciled' : diffPaise > 0 ? `⚠ Remaining to Allocate: ₹${(diffPaise / 100).toFixed(2)}` : `⚠ Over-allocated by ₹${(Math.abs(diffPaise) / 100).toFixed(2)}`}</span>
                  <span>Total Allocated: ₹{(allocatedTotalPaise / 100).toFixed(2)}</span>
                </div>
              );
            })()}

            {/* Modal Actions */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                type="button"
                onClick={() => handleFinalizeSale()}
                disabled={isFinalizing || cartItems.length === 0}
                style={{
                  flex: 1,
                  padding: '14px',
                  backgroundColor: isFinalizing ? '#999' : '#8B1E2D',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontWeight: 'bold',
                  fontSize: 16,
                  cursor: isFinalizing ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 12px rgba(139,30,45,0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                }}
              >
                <span>{isFinalizing ? '⏳' : '⚡'}</span>
                <span>{isFinalizing ? 'Committing Atomic SQLite Transaction...' : 'Finalize Sale & Commit (Ctrl+Enter)'}</span>
              </button>
              <button
                type="button"
                onClick={() => setIsPaymentModalOpen(false)}
                style={{
                  padding: '14px 20px',
                  backgroundColor: '#eee',
                  border: '1px solid #ccc',
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Back to Cart
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* 5. Quick UPI / QR Payment Modal */}
      {/* ========================================================= */}
      {isUpiModalOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1150 }}>
          <div style={{ backgroundColor: '#fff', borderRadius: 12, padding: 24, width: 420, maxWidth: '90%', boxShadow: '0 12px 32px rgba(0,0,0,0.25)', border: '2px solid #1565C0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 18, color: '#1565C0', fontWeight: 800 }}>
                  📱 UPI / QR Quick Payment
                </h3>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                  Terminal {currentSession.branch_id}/{currentSession.terminal_id} • Counter {currentSession.counter_id}
                </div>
              </div>
              <button
                onClick={() => { setIsUpiModalOpen(false); setUpiSimulatedVerified(false); }}
                style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
              >
                ✕
              </button>
            </div>

            {/* Bill Amount Display */}
            <div style={{ backgroundColor: '#E3F2FD', border: '1px solid #BBDEFB', borderRadius: 8, padding: '14px 16px', textAlign: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 12, color: '#1565C0', fontWeight: 'bold', display: 'block' }}>TOTAL AMOUNT TO PAY</span>
              <div style={{ fontSize: 32, fontWeight: 900, color: '#0D47A1', marginTop: 2 }}>
                ₹{(totalGrossPaise / 100).toFixed(2)}
              </div>
              <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>
                Items: {cartItems.length} | GST Inclusive (5%)
              </div>
            </div>

            {/* Dynamic QR Display Graphic */}
            <div style={{ textAlign: 'center', padding: '16px 0', border: '1px dashed #B0BEC5', borderRadius: 8, backgroundColor: '#FAFAFA', marginBottom: 16 }}>
              <div style={{ fontSize: 44, marginBottom: 4 }}>📲</div>
              <div style={{ fontWeight: 'bold', fontSize: 14, color: '#37474F' }}>Scan with GPay / PhonePe / Paytm</div>
              <div style={{ fontSize: 12, color: '#78909C', marginTop: 2 }}>UPI ID: malgudi.mithais@icici</div>
            </div>

            {/* Simple Counter Soundbox & UPI Confirmation */}
            <div style={{ padding: '12px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13, backgroundColor: '#E8F5E9', border: '1px solid #C8E6C9', color: '#2E7D32', textAlign: 'center' }}>
              <strong>🔊 Shop QR & Counter Soundbox Mode</strong>
              <div style={{ fontSize: 12, marginTop: 4, color: '#388E3C' }}>
                Customer scans the counter QR standee. Once payment is confirmed on your soundbox or phone, click below to finalize.
              </div>
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                onClick={handleQuickUpiFinalize}
                disabled={isFinalizing}
                style={{
                  padding: '14px',
                  backgroundColor: isFinalizing ? '#999' : '#1565C0',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontWeight: 'bold',
                  fontSize: 16,
                  cursor: isFinalizing ? 'not-allowed' : 'pointer',
                  boxShadow: '0 4px 10px rgba(21,101,192,0.25)',
                }}
              >
                {isFinalizing ? 'Finalizing Bill...' : `✓ Acknowledge UPI & Finalize Bill (₹${(totalGrossPaise / 100).toFixed(2)})`}
              </button>

              <button
                type="button"
                onClick={() => { setIsUpiModalOpen(false); setUpiSimulatedVerified(false); }}
                style={{ padding: '10px', backgroundColor: '#eee', border: '1px solid #ccc', borderRadius: 6, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
              >
                Cancel & Back to Cart
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 3: Invoices & Reprints History Drawer/Modal         */}
      {/* ========================================================= */}
      {isHistoryModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1100,
            padding: 16,
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              border: '2px solid #8B1E2D',
              borderRadius: 12,
              padding: 24,
              maxWidth: 640,
              width: '100%',
              maxHeight: '80vh',
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 18 }}>Recent Invoices & Reprints</h3>
              <button
                onClick={() => setIsHistoryModalOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
              >
                ✕
              </button>
            </div>

            {/* Quick Invoice Search */}
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                placeholder="🔍 Search Invoice # (e.g. MM-IB-0001)..."
                value={invoicesSearch}
                onChange={e => {
                  setInvoicesSearch(e.target.value);
                  setInvoicesPage(1);
                }}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid #ccc',
                  fontSize: 13,
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {(() => {
              const filteredHistory = persistedHistory.filter(s => {
                if (!invoicesSearch.trim()) return true;
                const q = invoicesSearch.trim().toLowerCase();
                return s.invoice_number.toLowerCase().includes(q) || s.sale_id.toLowerCase().includes(q);
              });

              if (filteredHistory.length === 0) {
                return (
                  <div style={{ textAlign: 'center', padding: '30px 0', color: '#666' }}>
                    {persistedHistory.length === 0
                      ? 'No invoices recorded yet in this session.'
                      : 'No invoices match your search query.'}
                  </div>
                );
              }

              const pagedHistory = filteredHistory.slice(
                (invoicesPage - 1) * INVOICES_PER_PAGE,
                invoicesPage * INVOICES_PER_PAGE
              );

              return (
                <div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ backgroundColor: '#f9f9f9', textAlign: 'left', borderBottom: '2px solid #ddd' }}>
                        <th style={{ padding: 8 }}>Invoice #</th>
                        <th style={{ padding: 8 }}>Amount</th>
                        <th style={{ padding: 8 }}>Status</th>
                        <th style={{ padding: 8 }}>Date/Time</th>
                        <th style={{ padding: 8, textAlign: 'right' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedHistory.map((s, idx) => (
                        <tr key={idx} style={{ borderBottom: '1px solid #eee' }}>
                          <td style={{ padding: 8, fontWeight: 'bold' }}>{s.invoice_number}</td>
                          <td style={{ padding: 8 }}>₹{(s.net_payable_paise / 100).toFixed(2)}</td>
                          <td style={{ padding: 8 }}>
                            {s.sale_status === 'VOIDED' ? (
                              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: '#FFEBEE', color: '#C62828', fontWeight: 'bold' }}>
                                VOIDED / REFUNDED
                              </span>
                            ) : (
                              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, backgroundColor: '#E8F5E9', color: '#2E7D32', fontWeight: 'bold' }}>
                                {s.payment_status}
                              </span>
                            )}
                          </td>
                          <td style={{ padding: 8, color: '#666', whiteSpace: 'nowrap' }}>{formatDateTime(s.created_at)}</td>
                          <td style={{ padding: 8, textAlign: 'right' }}>
                            <button
                              onClick={() => {
                                handleOpenReceiptReprint(s.invoice_number, s);
                                setIsHistoryModalOpen(false);
                              }}
                              style={{
                                padding: '4px 10px',
                                fontSize: 12,
                                backgroundColor: '#8B1E2D',
                                color: '#fff',
                                border: 'none',
                                borderRadius: 4,
                                cursor: 'pointer',
                                fontWeight: 600,
                              }}
                            >
                              Reprint
                            </button>
                            {s.sale_status !== 'VOIDED' && currentSession?.role === 'ADMIN' && (
                              <button
                                onClick={() => {
                                  setVoidTargetSale(s);
                                  setVoidReason('');
                                  setVoidError(null);
                                }}
                                style={{
                                  padding: '4px 8px',
                                  fontSize: 12,
                                  backgroundColor: '#FFF3E0',
                                  color: '#C62828',
                                  border: '1px solid #FFCDD2',
                                  borderRadius: 4,
                                  cursor: 'pointer',
                                  fontWeight: 600,
                                  marginLeft: 6,
                                }}
                              >
                                Void / Return
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {renderPaginationBar(invoicesPage, filteredHistory.length, INVOICES_PER_PAGE, setInvoicesPage)}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 4: Cashier Handover Modal                           */}
      {/* ========================================================= */}
      {isSwitchModalOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1200 }}>
          <div style={{ backgroundColor: '#FFF9F0', border: '2px solid #8B1E2D', padding: 24, borderRadius: 10, width: 380, boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>
            <h3 style={{ color: '#8B1E2D', margin: '0 0 6px 0', fontSize: 18 }}>🔄 Cashier Handover</h3>
            <p style={{ fontSize: 12, color: '#555', margin: '0 0 16px 0' }}>
              The current cash session (<strong>{currentSession.session_id}</strong>) and drawer balance will remain active and attributed to the incoming cashier.
            </p>

            {switchError && (
              <div style={{ backgroundColor: '#ffebee', color: '#c62828', padding: '8px', borderRadius: 4, marginBottom: 12, fontSize: 12 }}>
                ⚠ {switchError}
              </div>
            )}

            <form onSubmit={handleCashierHandover}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>Incoming Cashier Username</label>
                <input
                  type="text"
                  placeholder="e.g. kavitha"
                  value={switchUsername}
                  onChange={e => setSwitchUsername(e.target.value)}
                  required
                  autoFocus
                  style={{ width: '100%', padding: '8px', fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 'bold', marginBottom: 4 }}>Security PIN</label>
                <input
                  type="password"
                  placeholder="••••••"
                  value={switchPin}
                  onChange={e => setSwitchPin(e.target.value)}
                  required
                  style={{ width: '100%', padding: '8px', fontSize: 14, letterSpacing: 3, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="submit"
                  style={{ flex: 1, padding: '10px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 4, fontWeight: 'bold', cursor: 'pointer' }}
                >
                  Verify & Switch
                </button>
                <button
                  type="button"
                  onClick={() => setIsSwitchModalOpen(false)}
                  style={{ padding: '10px 14px', backgroundColor: '#ddd', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 4B: Optional Customer Details Modal                 */}
      {/* ========================================================= */}
      {isCustomerModalOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1250, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', padding: 22, borderRadius: 10, width: 420, maxWidth: '95vw', boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #EBEBE6', paddingBottom: 10, marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 17, fontWeight: 800 }}>
                  👤 Customer Details (Optional)
                </h3>
                <div style={{ fontSize: 12, color: '#777', marginTop: 2 }}>
                  வாடிக்கையாளர் விவரம் • Leave blank for regular walk-in
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCustomerModalOpen(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, color: '#999', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const phone = customerForm.phone.trim();
                const name = customerForm.name.trim();
                const location = customerForm.location.trim();

                // If phone is entered, it MUST be a valid 10-digit Indian mobile number
                if (phone.length > 0) {
                  if (phone.length !== 10 || !/^[6-9]\d{9}$/.test(phone)) {
                    setCustomerPhoneError('Please enter a valid 10-digit mobile number starting with 6, 7, 8, or 9');
                    return;
                  }
                }

                if (name || phone || location) {
                  setCustomerInfo({
                    name,
                    phone,
                    location,
                  });
                } else {
                  setCustomerInfo(null);
                }
                setCustomerPhoneError(null);
                setIsCustomerModalOpen(false);
              }}
            >
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: '#333' }}>
                    📱 Mobile / Phone Number
                  </label>
                  <span style={{ fontSize: 11, fontWeight: 700, color: customerPhoneError ? '#D32F2F' : customerForm.phone.length === 10 ? '#2E7D32' : '#888' }}>
                    {customerForm.phone.length === 0
                      ? 'Optional • 10 Digits'
                      : customerForm.phone.length === 10 && !customerPhoneError
                      ? '✓ Valid 10-Digit Mobile'
                      : `${customerForm.phone.length}/10 digits`}
                  </span>
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <span style={{
                    position: 'absolute',
                    left: 10,
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#555',
                    backgroundColor: '#F0ECE6',
                    padding: '3px 6px',
                    borderRadius: 4,
                    pointerEvents: 'none',
                    userSelect: 'none',
                  }}>
                    🇮🇳 +91
                  </span>
                  <input
                    type="tel"
                    autoFocus
                    maxLength={10}
                    placeholder="98421 88888"
                    value={customerForm.phone}
                    onChange={(e) => {
                      const cleaned = e.target.value.replace(/\D/g, '').slice(0, 10);
                      setCustomerForm(prev => ({ ...prev, phone: cleaned }));
                      if (cleaned.length === 0) {
                        setCustomerPhoneError(null);
                      } else if (!/^[6-9]/.test(cleaned)) {
                        setCustomerPhoneError('Mobile number must begin with 6, 7, 8, or 9');
                      } else if (cleaned.length < 10) {
                        setCustomerPhoneError(`Enter full 10-digit mobile number (${cleaned.length}/10)`);
                      } else {
                        setCustomerPhoneError(null);
                      }
                    }}
                    style={{
                      width: '100%',
                      padding: '9px 12px 9px 74px',
                      borderRadius: 6,
                      border: customerPhoneError
                        ? '2px solid #D32F2F'
                        : customerForm.phone.length === 10
                        ? '2px solid #2E7D32'
                        : '1px solid #CCC',
                      fontSize: 15,
                      fontWeight: 700,
                      letterSpacing: 1,
                      boxSizing: 'border-box',
                      outline: 'none',
                    }}
                  />
                </div>
                {customerPhoneError && (
                  <div style={{ color: '#D32F2F', fontSize: 11, fontWeight: 600, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span>⚠️</span> <span>{customerPhoneError}</span>
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: '#333' }}>
                    👤 Customer Name
                  </label>
                  <span style={{ fontSize: 11, color: '#888' }}>Optional</span>
                </div>
                <input
                  type="text"
                  maxLength={50}
                  placeholder="e.g. Ramesh Kumar"
                  value={customerForm.name}
                  onChange={(e) => setCustomerForm(prev => ({ ...prev, name: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #CCC', fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: '#333' }}>
                    📍 Area / Landmark / Address
                  </label>
                  <span style={{ fontSize: 11, color: '#888' }}>Optional</span>
                </div>
                <input
                  type="text"
                  maxLength={100}
                  placeholder="e.g. Iyer Bungalow / KK Nagar / Home Delivery"
                  value={customerForm.location}
                  onChange={(e) => setCustomerForm(prev => ({ ...prev, location: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #CCC', fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #eee', paddingTop: 14 }}>
                <button
                  type="button"
                  onClick={() => {
                    setCustomerInfo(null);
                    setCustomerForm({ name: '', phone: '', location: '' });
                    setCustomerPhoneError(null);
                    setIsCustomerModalOpen(false);
                  }}
                  style={{ padding: '8px 14px', border: '1px solid #ccc', borderRadius: 6, backgroundColor: '#f8f8f8', color: '#666', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                >
                  Clear (Walk-in)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCustomerPhoneError(null);
                    setIsCustomerModalOpen(false);
                  }}
                  style={{ padding: '8px 14px', border: '1px solid #ccc', borderRadius: 6, backgroundColor: '#f5f5f5', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ padding: '8px 18px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                >
                  ✓ Attach to Bill
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 5: Tax Invoice Receipt Modal                        */}
      {/* ========================================================= */}
      {activeReceiptModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1300, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', padding: 22, borderRadius: 8, width: 380, maxWidth: '95vw', fontFamily: 'monospace', fontSize: 12, boxShadow: '0 6px 20px rgba(0,0,0,0.25)', maxHeight: '90vh', overflowY: 'auto' }}>
            {/* Printable Receipt Area */}
            <div id="receipt-print-area">
              <div style={{ textAlign: 'center', borderBottom: '1px dashed #000', paddingBottom: 8, marginBottom: 8 }}>
                <div style={{ fontWeight: 'bold', fontSize: 16, letterSpacing: 0.5 }}>MALGUDI MITHAIS</div>
                {(() => {
                  const isUk =
                    activeReceiptModal.branch_id === 'UK' ||
                    (activeReceiptModal.branch_name || '').toLowerCase().includes('umachikulam');

                  const branchTitle = isUk ? 'Umachikulam Branch (UK)' : 'Iyer Bungalow Branch (IB)';
                  const branchAddress = isUk
                    ? 'Main Road, Umachikulam, Madurai - 625014'
                    : 'Natham Main Road, Iyer Bungalow, Madurai - 625014';

                  return (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#333', marginTop: 2 }}>
                        {branchTitle}
                      </div>
                      <div style={{ fontSize: 11, color: '#555' }}>{branchAddress}</div>
                    </>
                  );
                })()}
                <div style={{ fontSize: 11, color: '#555' }}>GSTIN: 33AAAAA0000A1Z5</div>
              </div>

              {activeReceiptModal.sale_status === 'VOIDED' && (
                <div style={{ backgroundColor: '#FFEBEE', color: '#B71C1C', fontWeight: 900, textAlign: 'center', padding: '6px 0', margin: '6px 0', border: '1px dashed #B71C1C', fontSize: 13, letterSpacing: 1 }}>
                  *** VOIDED / REFUNDED ***
                </div>
              )}

              <div style={{ marginBottom: 8, fontSize: 11, lineHeight: 1.5 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>Invoice:</strong> {activeReceiptModal.invoice_number}</span>
                  <span><strong>Status:</strong> {activeReceiptModal.payment_status}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span><strong>Cashier:</strong> {activeReceiptModal.cashier_name}</span>
                  <span><strong>Terminal:</strong> {activeReceiptModal.branch_id}/{activeReceiptModal.terminal_id}</span>
                </div>
                <div><strong>Date:</strong> {formatDateTime(activeReceiptModal.created_at)}</div>
                {(activeReceiptModal.customer_name || activeReceiptModal.customer_phone || activeReceiptModal.customer_location) && (
                  <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px dotted #ccc', fontSize: 11, lineHeight: 1.4 }}>
                    {activeReceiptModal.customer_name && <div><strong>Customer:</strong> {activeReceiptModal.customer_name}</div>}
                    {activeReceiptModal.customer_phone && <div><strong>Phone:</strong> {activeReceiptModal.customer_phone}</div>}
                    {activeReceiptModal.customer_location && <div><strong>Location:</strong> {activeReceiptModal.customer_location}</div>}
                  </div>
                )}
              </div>

              {/* Itemized Table */}
              <div style={{ borderTop: '1px dashed #000', borderBottom: '1px dashed #000', padding: '6px 0', marginBottom: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px dashed #aaa', textAlign: 'left' }}>
                      <th style={{ paddingBottom: 4, width: '45%' }}>Item</th>
                      <th style={{ paddingBottom: 4, textAlign: 'center', width: '18%' }}>Qty</th>
                      <th style={{ paddingBottom: 4, textAlign: 'right', width: '17%' }}>Rate</th>
                      <th style={{ paddingBottom: 4, textAlign: 'right', width: '20%' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeReceiptModal.items && activeReceiptModal.items.length > 0 ? (
                      activeReceiptModal.items.map((it, idx) => (
                        <tr key={idx} style={{ verticalAlign: 'top', borderBottom: '1px dotted #eee' }}>
                          <td style={{ padding: '4px 0' }}>
                            <div style={{ fontWeight: 600 }}>{it.product_name}</div>
                            {it.tamil_name && it.tamil_name.trim() !== '' && it.tamil_name.trim().toLowerCase() !== it.product_name.trim().toLowerCase() && (
                              <div style={{ fontSize: 10, color: '#666' }}>{it.tamil_name}</div>
                            )}
                          </td>
                          <td style={{ padding: '4px 0', textAlign: 'center', whiteSpace: 'nowrap' }}>{it.quantity_formatted}</td>
                          <td style={{ padding: '4px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            ₹{(it.unit_price_paise / 100).toFixed(0)}
                          </td>
                          <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            ₹{(it.gross_paise / 100).toFixed(2)}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={4} style={{ textAlign: 'center', padding: '8px 0', color: '#666' }}>
                          Items Billed: {activeReceiptModal.items_count || 1}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Tax & Net Totals */}
              <div style={{ borderBottom: '1px dashed #000', paddingBottom: 6, marginBottom: 8, fontSize: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#555' }}>
                  <span>Taxable Subtotal:</span>
                  <span>₹{(activeReceiptModal.subtotal_taxable_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#555' }}>
                  <span>CGST (2.5%):</span>
                  <span>₹{(activeReceiptModal.total_cgst_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: '#555' }}>
                  <span>SGST (2.5%):</span>
                  <span>₹{(activeReceiptModal.total_sgst_paise / 100).toFixed(2)}</span>
                </div>
                {activeReceiptModal.round_off_paise !== 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#555' }}>
                    <span>Round-off:</span>
                    <span>₹{(activeReceiptModal.round_off_paise / 100).toFixed(2)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 900, fontSize: 15, marginTop: 4, color: '#8B1E2D', borderTop: '1px solid #ddd', paddingTop: 4 }}>
                  <span>TOTAL NET PAYABLE:</span>
                  <span>₹{(activeReceiptModal.net_payable_paise / 100).toFixed(2)}</span>
                </div>
              </div>

              {/* Payment Tender Breakdown */}
              <div style={{ borderBottom: '1px dashed #000', paddingBottom: 6, marginBottom: 8, fontSize: 11 }}>
                {activeReceiptModal.payments && activeReceiptModal.payments.length > 0 ? (
                  activeReceiptModal.payments.map((p, idx) => (
                    <div key={idx} style={{ marginBottom: 2 }}>
                      {p.payment_method === 'CASH' ? (
                        <div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>💵 Cash Tendered:</span>
                            <span>₹{(p.tendered_paise / 100).toFixed(2)}</span>
                          </div>
                          {p.change_returned_paise > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', color: '#2E7D32' }}>
                              <span>Change Returned:</span>
                              <span>₹{(p.change_returned_paise / 100).toFixed(2)}</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span>📱 UPI / Soundbox:</span>
                          <span>₹{(p.net_amount_paise / 100).toFixed(2)}</span>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Payment Method:</span>
                    <span>{activeReceiptModal.payment_status}</span>
                  </div>
                )}
              </div>

              {/* Retail Customer Greetings */}
              <div style={{ textAlign: 'center', fontSize: 11, color: '#444', margin: '10px 0 6px 0' }}>
                <div style={{ fontWeight: 700 }}>Thank you for choosing Malgudi Mithais!</div>
                <div style={{ fontSize: 10, color: '#777', marginTop: 2 }}>Sweetening your celebrations • Visit again!</div>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="no-print" style={{ display: 'flex', gap: 10, marginTop: 14 }}>
              <button
                type="button"
                onClick={() => window.print()}
                style={{ flex: 1, padding: '10px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', fontSize: 13 }}
              >
                🖨️ Send to Printer
              </button>
              <button
                type="button"
                onClick={() => setActiveReceiptModal(null)}
                style={{ padding: '10px 18px', backgroundColor: '#eee', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 5B: Custom Category Add Dialog                       */}
      {/* ========================================================= */}
      {isAddCategoryModalOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1260, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', border: '2px solid #8B1E2D', borderRadius: 10, width: 440, maxWidth: '95vw', padding: 24, boxShadow: '0 10px 30px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 10, marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 17, fontWeight: 800 }}>
                  📁 Add New Category
                </h3>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  Create custom product category for billing & reports
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsAddCategoryModalOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAddCategory}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                  Category Name (English) *
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="e.g. Gift Hampers, Pickles, Dry Fruits"
                  value={newCatName}
                  onChange={e => {
                    const val = e.target.value;
                    setNewCatName(val);
                    if (!newCatSkuPrefix || newCatSkuPrefix.length <= 4) {
                      const autoPrefix = val.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase();
                      if (autoPrefix) setNewCatSkuPrefix(autoPrefix);
                    }
                  }}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                  Tamil Name (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. பரிசுப் பெட்டிகள், ஊறுகாய்"
                  value={newCatTamilName}
                  onChange={e => setNewCatTamilName(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <label style={{ fontSize: 12, fontWeight: 700, color: '#333' }}>
                    SKU Code Prefix (Optional)
                  </label>
                  <span style={{ fontSize: 11, color: '#888' }}>e.g. ICE, PIC, GFT</span>
                </div>
                <input
                  type="text"
                  maxLength={6}
                  placeholder={newCatName ? newCatName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() : 'e.g. ICE'}
                  value={newCatSkuPrefix}
                  onChange={e => setNewCatSkuPrefix(e.target.value.toUpperCase())}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 14, fontFamily: 'monospace', fontWeight: 700, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                />
                <span style={{ fontSize: 10, color: '#666', marginTop: 3, display: 'block' }}>
                  Products in this category will auto-number as {newCatSkuPrefix.trim() || (newCatName ? newCatName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() : 'CODE')}-001, {newCatSkuPrefix.trim() || (newCatName ? newCatName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() : 'CODE')}-002.
                </span>
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                  Display Icon (Emoji)
                </label>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="text"
                    maxLength={3}
                    value={newCatIcon}
                    onChange={e => setNewCatIcon(e.target.value)}
                    style={{ width: 60, padding: '8px 10px', fontSize: 20, textAlign: 'center', border: '1px solid #ccc', borderRadius: 6 }}
                  />
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {['📦', '🎁', '🥒', '🥜', '🍪', '🥨', '🍯', '🍫', '☕'].map(icon => (
                      <button
                        key={icon}
                        type="button"
                        onClick={() => setNewCatIcon(icon)}
                        style={{
                          fontSize: 16,
                          padding: '4px 8px',
                          border: newCatIcon === icon ? '2px solid #8B1E2D' : '1px solid #ddd',
                          backgroundColor: newCatIcon === icon ? '#FFF9F0' : '#f9f9f9',
                          borderRadius: 4,
                          cursor: 'pointer',
                        }}
                      >
                        {icon}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid #eee', paddingTop: 14 }}>
                <button
                  type="button"
                  onClick={() => setIsAddCategoryModalOpen(false)}
                  style={{ padding: '8px 16px', border: '1px solid #ccc', borderRadius: 6, backgroundColor: '#f5f5f5', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{ padding: '8px 18px', backgroundColor: '#8B1E2D', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}
                >
                  ✓ Save Category
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 5C: Morning Opening Cash Float Modal (தொடக்க ரொக்கம்) */}
      {/* ========================================================= */}
      {isOpeningFloatModalOpen && currentSession && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1240, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', border: '2px solid #8B1E2D', borderRadius: 12, width: 480, maxWidth: '95vw', padding: 24, boxShadow: '0 12px 32px rgba(139,30,45,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 18, fontWeight: 800 }}>
                  ☀️ Morning Opening Cash Float (தொடக்க ரொக்கம்)
                </h3>
                <div style={{ fontSize: 12, color: '#666', marginTop: 3 }}>
                  Branch: <strong>{syncConfig?.branch_name || currentSession.branch_id}</strong> • Terminal: <strong>{currentSession.terminal_id || 'T1'}</strong>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsOpeningFloatModalOpen(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, color: '#999', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConfirmOpeningFloat}>
              {/* Role-based Identity Verification */}
              {currentSession.role === 'ADMIN' ? (
                <div style={{ backgroundColor: '#FFF9F0', border: '1px solid #EAD8C7', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#8B1E2D', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    👑 Store Owner Session
                  </div>
                  <div style={{ fontSize: 13, color: '#333', marginTop: 2, fontWeight: 600 }}>
                    {currentSession.display_name} (No staff verification required)
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 6 }}>
                    👤 Cashier / Staff Name (பணியாளர் பெயர்)
                  </label>
                  <input
                    type="text"
                    defaultValue={currentSession.display_name}
                    readOnly
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      borderRadius: 6,
                      border: '1px solid #ccc',
                      backgroundColor: '#FAF9F8',
                      fontSize: 14,
                      fontWeight: 600,
                      color: '#444',
                      boxSizing: 'border-box',
                    }}
                  />
                  <div style={{ fontSize: 11, color: '#777', marginTop: 4 }}>
                    Cash drawer starting float will be attributed to this staff member's register shift.
                  </div>
                </div>
              )}

              {/* Starting Cash Amount */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 700, color: '#1F1F1F', marginBottom: 6 }}>
                  💵 Starting Cash in Drawer (தொடக்க இருப்பு பணம்) <span style={{ color: '#8B1E2D' }}>*</span>
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 14, top: 10, fontSize: 18, fontWeight: 700, color: '#8B1E2D' }}>₹</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    required
                    value={openingFloatInput}
                    onChange={e => setOpeningFloatInput(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 12px 10px 36px',
                      borderRadius: 6,
                      border: '2px solid #8B1E2D',
                      fontSize: 20,
                      fontWeight: 800,
                      color: '#8B1E2D',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                {/* Quick Float Denomination Buttons */}
                <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                  {[
                    { label: '₹1,000', val: 1000 },
                    { label: '₹2,000', val: 2000 },
                    { label: '₹3,000', val: 3000 },
                    { label: '₹5,000', val: 5000 },
                  ].map(btn => (
                    <button
                      key={btn.val}
                      type="button"
                      onClick={() => setOpeningFloatInput(btn.val.toString())}
                      style={{
                        padding: '5px 10px',
                        fontSize: 12,
                        fontWeight: 700,
                        backgroundColor: '#FFF9F0',
                        border: '1px solid #D0C0B0',
                        borderRadius: 4,
                        color: '#6F1623',
                        cursor: 'pointer',
                      }}
                    >
                      {btn.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const cur = parseFloat(openingFloatInput) || 0;
                      setOpeningFloatInput((cur + 500).toString());
                    }}
                    style={{
                      padding: '5px 10px',
                      fontSize: 12,
                      fontWeight: 700,
                      backgroundColor: '#f5f5f5',
                      border: '1px solid #ccc',
                      borderRadius: 4,
                      color: '#333',
                      cursor: 'pointer',
                    }}
                  >
                    +₹500
                  </button>
                </div>
              </div>

              {/* Float Notes / Breakdown */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#555', marginBottom: 4 }}>
                  Notes / Denomination Breakdown (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. 500x2, 200x3, 100x4"
                  value={openingFloatNotes}
                  onChange={e => setOpeningFloatNotes(e.target.value)}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid #eee', paddingTop: 14 }}>
                <button
                  type="button"
                  onClick={() => setIsOpeningFloatModalOpen(false)}
                  style={{ padding: '9px 16px', border: '1px solid #ccc', borderRadius: 6, backgroundColor: '#f5f5f5', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  Skip for Now
                </button>
                <button
                  type="submit"
                  disabled={isOpeningFloatSubmitting}
                  style={{
                    padding: '9px 22px',
                    backgroundColor: '#8B1E2D',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 700,
                    cursor: isOpeningFloatSubmitting ? 'not-allowed' : 'pointer',
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {isOpeningFloatSubmitting ? '⏳ Recording...' : '✓ Confirm Starting Float'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 5D: Day-End Cash Drawer Closure Modal (முடிவு ரொக்கம்) */}
      {/* ========================================================= */}
      {isDayCloseModalOpen && currentSession && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1240, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', border: '2px solid #8B1E2D', borderRadius: 12, width: 520, maxWidth: '95vw', padding: 24, boxShadow: '0 12px 32px rgba(139,30,45,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 18, fontWeight: 800 }}>
                  🌙 Register Day-End Closure & Z-Report (முடிவு ரொக்கம்)
                </h3>
                <div style={{ fontSize: 12, color: '#666', marginTop: 3 }}>
                  Branch: <strong>{syncConfig?.branch_name || currentSession.branch_id}</strong> • Business Date: <strong>{new Date().toISOString().split('T')[0]}</strong>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsDayCloseModalOpen(false)}
                style={{ background: 'none', border: 'none', fontSize: 20, color: '#999', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleExecuteDayClose}>
              {/* Auto-Calculated Day Summary Card */}
              <div style={{ backgroundColor: '#FDFBF7', border: '1px solid #EAD8C7', borderRadius: 8, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#6A1A24', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>📊</span> <span>Calculated Cash In Drawer (தானியங்கி கணக்கீடு)</span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12, fontSize: 12 }}>
                  <div style={{ backgroundColor: '#fff', border: '1px solid #EFEAE3', borderRadius: 6, padding: '8px 12px' }}>
                    <div style={{ color: '#777', fontSize: 11 }}>🌅 Morning Opening Float</div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#333', marginTop: 2 }}>
                      ₹{(liveDrawerOpeningPaise / 100).toFixed(2)}
                    </div>
                  </div>
                  <div style={{ backgroundColor: '#fff', border: '1px solid #EFEAE3', borderRadius: 6, padding: '8px 12px' }}>
                    <div style={{ color: '#777', fontSize: 11 }}>💵 Cash Sales Today</div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#2E7D32', marginTop: 2 }}>
                      +₹{(liveDrawerCashSalesPaise / 100).toFixed(2)}
                    </div>
                  </div>
                </div>

                <div style={{ backgroundColor: '#FFF4E5', border: '1px solid #FFE0B2', borderRadius: 6, padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#B25900', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      Expected Drawer Cash (கணக்கு இருப்பு)
                    </div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 1 }}>
                      Opening Float + Cash Sales
                    </div>
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#8B1E2D' }}>
                    ₹{(liveDrawerExpectedPaise / 100).toFixed(2)}
                  </div>
                </div>

                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#2E7D32', fontWeight: 600 }}>
                  <span>✅</span> <span>Calculated directly from all system bills — staff typing not required.</span>
                </div>
              </div>

              {/* Optional Collapsible Expander for Discrepancy / Petty Cash */}
              <div style={{ marginBottom: 18 }}>
                <button
                  type="button"
                  onClick={() => setIsManualVarianceExpanded(prev => !prev)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: '#666',
                    fontSize: 12,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontWeight: 600,
                  }}
                >
                  <span>{isManualVarianceExpanded ? '▼' : '▶'}</span>
                  <span style={{ textDecoration: 'underline' }}>
                    Need to log tea/milk expense or unexpected cash difference?
                  </span>
                </button>

                {isManualVarianceExpanded && (
                  <div style={{ marginTop: 12, padding: 12, backgroundColor: '#FAFAFA', border: '1px dashed #CCC', borderRadius: 6 }}>
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#333', marginBottom: 4 }}>
                        Physical Counted Cash (எண்ணிய ரொக்கம்):
                      </label>
                      <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: 10, top: 7, fontSize: 14, fontWeight: 700, color: '#555' }}>₹</span>
                        <input
                          type="number"
                          step="any"
                          min="0"
                          value={countedClosingCashInput}
                          onChange={e => setCountedClosingCashInput(e.target.value)}
                          style={{
                            width: '100%',
                            padding: '6px 10px 6px 26px',
                            borderRadius: 4,
                            border: '1px solid #ccc',
                            fontSize: 14,
                            fontWeight: 700,
                            boxSizing: 'border-box',
                          }}
                        />
                      </div>
                    </div>

                    {countedClosingCashInput !== '' && !isNaN(parseFloat(countedClosingCashInput)) && (
                      (() => {
                        const countedPaise = Math.round(parseFloat(countedClosingCashInput) * 100);
                        const variancePaise = countedPaise - liveDrawerExpectedPaise;
                        if (variancePaise === 0) return null;
                        return (
                          <div style={{
                            padding: '6px 10px',
                            borderRadius: 4,
                            backgroundColor: variancePaise > 0 ? '#FFF8E1' : '#FFEBEE',
                            color: variancePaise > 0 ? '#F57F17' : '#C62828',
                            fontWeight: 700,
                            fontSize: 12,
                            marginBottom: 10,
                          }}>
                            {variancePaise > 0
                              ? `▲ Cash Overage: +₹${(variancePaise / 100).toFixed(2)}`
                              : `▼ Cash Shortage / Expense: -₹${(Math.abs(variancePaise) / 100).toFixed(2)}`}
                          </div>
                        );
                      })()
                    )}

                    <div>
                      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#555', marginBottom: 4 }}>
                        Reason for discrepancy / Petty cash notes:
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. ₹50 tea/refreshments, ₹10 coin shortage"
                        value={dayCloseNotes}
                        onChange={e => setDayCloseNotes(e.target.value)}
                        style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid #ccc', fontSize: 12, boxSizing: 'border-box' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid #eee', paddingTop: 14 }}>
                <button
                  type="button"
                  onClick={() => setIsDayCloseModalOpen(false)}
                  style={{ padding: '9px 16px', border: '1px solid #ccc', borderRadius: 6, backgroundColor: '#f5f5f5', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isDayCloseSubmitting}
                  style={{
                    padding: '10px 22px',
                    backgroundColor: '#8B1E2D',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 800,
                    cursor: isDayCloseSubmitting ? 'not-allowed' : 'pointer',
                    fontSize: 14,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    boxShadow: '0 2px 6px rgba(139, 30, 45, 0.3)',
                  }}
                >
                  {isDayCloseSubmitting ? '⏳ Closing Day...' : '🌙 Confirm Day Close & Print Z-Report (1-Click)'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 5E: Day-End Z-Report 80mm Printable Slip Modal      */}
      {/* ========================================================= */}
      {activeZReportModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1250, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', borderRadius: 10, maxWidth: 440, width: '100%', maxHeight: '92vh', overflowY: 'auto', padding: 20, boxShadow: '0 10px 30px rgba(0,0,0,0.3)', border: '2px solid #8B1E2D' }}>
            
            {/* Top Close Bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: '#8B1E2D' }}>
                📋 80mm Day-End Z-Report Slip
              </span>
              <button
                type="button"
                onClick={() => setActiveZReportModal(null)}
                style={{ background: 'none', border: 'none', fontSize: 18, color: '#999', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            {/* 80mm Thermal Receipt Content */}
            <div id="z-report-thermal-slip" style={{ fontFamily: 'Courier New, monospace, sans-serif', fontSize: 12, lineHeight: 1.35, color: '#000', backgroundColor: '#fff', padding: '10px 4px' }}>
              <div style={{ textAlign: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: -0.5 }}>மால்குடி மிட்டாய்ஸ்</div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>MALGUDI MITHAIS</div>
                <div style={{ fontSize: 11, color: '#333' }}>{activeZReportModal.branch_name}</div>
                <div style={{ fontSize: 11, color: '#444' }}>Terminal: {activeZReportModal.terminal_id} | Session: {activeZReportModal.session_id}</div>
                <div style={{ fontSize: 11, color: '#444' }}>Date: {activeZReportModal.business_date}</div>
                <div style={{ fontSize: 10, color: '#666' }}>Closed At: {activeZReportModal.closed_at ? formatDateTime(activeZReportModal.closed_at) : 'Active'}</div>
                <div style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />
                <div style={{ fontSize: 13, fontWeight: 900, textTransform: 'uppercase' }}>*** END OF DAY Z-REPORT ***</div>
                <div style={{ fontSize: 11, fontWeight: 700 }}>முடிவு தணிக்கை அறிக்கை</div>
                <div style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />
              </div>

              {/* Section 1: Cash Drawer Reconciliation */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 800, textDecoration: 'underline', marginBottom: 4 }}>1. CASH RECONCILIATION</div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Opening Cash Float:</span>
                  <span>₹{(activeZReportModal.opening_float_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>(+) Cash Sales In:</span>
                  <span>₹{(activeZReportModal.cash_sales_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>(-) Cash Refunds:</span>
                  <span>₹{(activeZReportModal.cash_refunds_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ borderTop: '1px dotted #000', margin: '4px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                  <span>Expected Drawer Cash:</span>
                  <span>₹{(activeZReportModal.expected_closing_cash_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700 }}>
                  <span>Counted Closing Cash:</span>
                  <span>₹{(activeZReportModal.counted_closing_cash_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 900, fontSize: 13 }}>
                  <span>DRAWER VARIANCE:</span>
                  <span>
                    {activeZReportModal.variance_paise === 0
                      ? '₹0.00 (EXACT)'
                      : activeZReportModal.variance_paise > 0
                      ? `+₹${(activeZReportModal.variance_paise / 100).toFixed(2)} (OVER)`
                      : `-₹${(Math.abs(activeZReportModal.variance_paise) / 100).toFixed(2)} (SHORT)`}
                  </span>
                </div>
                {activeZReportModal.variance_notes && (
                  <div style={{ fontSize: 10, marginTop: 2, fontStyle: 'italic' }}>
                    Note: {activeZReportModal.variance_notes}
                  </div>
                )}
              </div>

              <div style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />

              {/* Section 2: Sales & Volume */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 800, textDecoration: 'underline', marginBottom: 4 }}>2. SALES & BILL VOLUME</div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Total Bills Printed:</span>
                  <span>{activeZReportModal.total_bills_recorded}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Active Settled Bills:</span>
                  <span>{activeZReportModal.active_bills_count}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Voided/Cancelled Bills:</span>
                  <span>{activeZReportModal.voided_bills_count}</span>
                </div>
                <div style={{ borderTop: '1px dotted #000', margin: '4px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
                  <span>GROSS TURNOVER:</span>
                  <span>₹{(activeZReportModal.gross_sales_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
                  <span>NET REVENUE:</span>
                  <span>₹{(activeZReportModal.net_sales_paise / 100).toFixed(2)}</span>
                </div>
              </div>

              <div style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />

              {/* Section 3: Tender Realization */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 800, textDecoration: 'underline', marginBottom: 4 }}>3. PAYMENT METHOD BREAKDOWN</div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Cash Realized:</span>
                  <span>₹{(activeZReportModal.cash_realized_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>UPI / Digital Realized:</span>
                  <span>₹{(activeZReportModal.upi_realized_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ borderTop: '1px dotted #000', margin: '4px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
                  <span>TOTAL REALIZED:</span>
                  <span>₹{((activeZReportModal.cash_realized_paise + activeZReportModal.upi_realized_paise) / 100).toFixed(2)}</span>
                </div>
              </div>

              <div style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />

              {/* Section 4: GST Breakdown */}
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 800, textDecoration: 'underline', marginBottom: 4 }}>4. GST AUDIT (5% COMPOSITE)</div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Taxable Value (Ex-Tax):</span>
                  <span>₹{(activeZReportModal.total_taxable_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>CGST (2.5%):</span>
                  <span>₹{(activeZReportModal.total_cgst_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>SGST (2.5%):</span>
                  <span>₹{(activeZReportModal.total_sgst_paise / 100).toFixed(2)}</span>
                </div>
                <div style={{ borderTop: '1px dotted #000', margin: '4px 0' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800 }}>
                  <span>TOTAL GST:</span>
                  <span>₹{(activeZReportModal.total_tax_paise / 100).toFixed(2)}</span>
                </div>
              </div>

              <div style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />
              
              <div style={{ textAlign: 'center', fontSize: 11, marginTop: 8 }}>
                <div>Closed by: <strong>{activeZReportModal.closed_by_user}</strong></div>
                <div>Offline Sync Outbox: {activeZReportModal.pending_sync_count} events pending</div>
                <div style={{ marginTop: 6, fontWeight: 700 }}>*** END OF OFFICIAL Z-SLIP ***</div>
              </div>
            </div>

            {/* Print & Close Actions */}
            <div className="no-print" style={{ display: 'flex', gap: 10, marginTop: 16, borderTop: '1px solid #eee', paddingTop: 14 }}>
              <button
                type="button"
                onClick={() => setActiveZReportModal(null)}
                style={{ flex: 1, padding: '10px', border: '1px solid #ccc', borderRadius: 6, backgroundColor: '#f5f5f5', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => window.print()}
                style={{
                  flex: 1.5,
                  padding: '10px',
                  backgroundColor: '#8B1E2D',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 6,
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontSize: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                🖨️ Print 80mm Z-Slip
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 6: Product Add / Edit Dialog                         */}
      {/* ========================================================= */}
      {isProductModalOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1250, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', border: '2px solid #8B1E2D', borderRadius: 10, width: 560, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto', padding: 24, boxShadow: '0 10px 30px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 10, marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 17, fontWeight: 800 }}>
                  {editingProduct ? `✏️ Edit Product: ${editingProduct.name}` : '➕ Add New Catalog Product'}
                </h3>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  Database-backed inventory item • Branch Madurai (IB)
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsProductModalOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
              >
                ✕
              </button>
            </div>

            {prodFormError && (
              <div style={{ backgroundColor: '#FFEBEE', color: '#C62828', padding: '10px 12px', borderRadius: 6, marginBottom: 14, fontSize: 12, border: '1px solid #FFCDD2' }}>
                ⚠️ {prodFormError}
              </div>
            )}

            <form onSubmit={handleSaveProduct}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    Product Name (English) *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Special Ghee Mysore Pak"
                    value={prodFormName}
                    onChange={e => setProdFormName(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                  />
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: '#333' }}>
                      Tamil Name (தமிழ் பெயர்)
                    </label>
                    <span style={{ fontSize: 11, color: '#888' }}>Optional</span>
                  </div>
                  <input
                    type="text"
                    placeholder="e.g. நெய் மைசூர் பாகு (Optional)"
                    value={prodFormTamilName}
                    onChange={e => setProdFormTamilName(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                  />
                  <span style={{ fontSize: 10, color: '#777', marginTop: 2, display: 'block' }}>
                    Defaults to English name on receipts if left blank.
                  </span>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <label style={{ fontSize: 12, fontWeight: 700, color: '#333' }}>
                      SKU Code *
                    </label>
                    <button
                      type="button"
                      onClick={() => setProdFormSku(generateNextSku(prodFormCategory, catalog, categories))}
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        background: '#FFF9F0',
                        border: '1px solid #EAD8C7',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontWeight: 600,
                        color: '#8B1E2D',
                      }}
                      title="Regenerate next sequential code for this category"
                    >
                      ⚡ Auto
                    </button>
                  </div>
                  <input
                    type="text"
                    required
                    placeholder="e.g. SWT-001"
                    value={prodFormSku}
                    onChange={e => setProdFormSku(e.target.value.toUpperCase())}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace', fontWeight: 600 }}
                  />
                  <span style={{ fontSize: 10, color: '#666', marginTop: 2, display: 'block' }}>
                    💡 Auto-assigned. You can edit or customize this anytime.
                  </span>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    Barcode (EAN/UPC - Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. 8901234567890"
                    value={prodFormBarcode}
                    onChange={e => setProdFormBarcode(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace' }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    Category *
                  </label>
                  <select
                    value={prodFormCategory}
                    onChange={e => {
                      const newCat = e.target.value;
                      setProdFormCategory(newCat);
                      if (!editingProduct) {
                        setProdFormSku(generateNextSku(newCat, catalog, categories));
                        if (newCat === 'cat_bakery') {
                          setProdFormHsn('19059020');
                          setProdFormGstPercent(5);
                        } else if (newCat === 'cat_beverages') {
                          setProdFormHsn('22029990');
                          setProdFormGstPercent(12);
                        } else {
                          setProdFormHsn('21069099');
                          setProdFormGstPercent(5);
                        }
                      }
                    }}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', backgroundColor: '#fff' }}
                  >
                    {categories.filter(c => c.id !== 'all').map(c => (
                      <option key={c.id} value={c.id}>
                        {c.icon} {c.name} ({c.tamil_name})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    Pricing Unit *
                  </label>
                  <select
                    value={prodFormPricingUnit}
                    onChange={e => {
                      const pu = e.target.value as PricingUnit;
                      setProdFormPricingUnit(pu);
                      setProdFormInventoryUnit(pu === 'PER_KG' ? 'MG' : (pu.replace('PER_', '') as InventoryUnit));
                    }}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', backgroundColor: '#fff' }}
                  >
                    <option value="PER_KG">Per Kilogram (Kg / Weight based)</option>
                    <option value="PER_PIECE">Per Piece (Single Item)</option>
                    <option value="PER_PACK">Per Pack (Packet)</option>
                    <option value="PER_BOX">Per Box (Gift / Standard Box)</option>
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    Selling Price (₹) *
                  </label>
                  <input
                    type="number"
                    step="any"
                    min="0.01"
                    required
                    placeholder="e.g. 680"
                    value={prodFormPriceRupees}
                    onChange={e => setProdFormPriceRupees(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 14, fontWeight: 700, border: '1.5px solid #8B1E2D', borderRadius: 6, boxSizing: 'border-box' }}
                  />
                  <span style={{ fontSize: 10, color: '#777' }}>Tax-inclusive price</span>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    GST Rate (%) *
                  </label>
                  <select
                    value={prodFormGstPercent}
                    onChange={e => setProdFormGstPercent(Number(e.target.value))}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', backgroundColor: '#fff' }}
                  >
                    <option value={5}>5% (Standard Sweets / Savouries / Bakery)</option>
                    <option value={12}>12% (Packaged / Specialty)</option>
                    <option value={18}>18% (Commercial / Other)</option>
                  </select>
                  <span style={{ fontSize: 10, color: '#777' }}>CGST + SGST</span>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    HSN Code *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. 21069099"
                    value={prodFormHsn}
                    onChange={e => setProdFormHsn(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace' }}
                  />
                </div>
              </div>

              {!editingProduct && (
                <div style={{ backgroundColor: '#FFFDF9', border: '1px solid #EAD8C7', borderRadius: 6, padding: 12, marginBottom: 14 }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#8B1E2D' }}>
                    Initial Opening Physical Stock ({prodFormPricingUnit === 'PER_KG' ? 'kg' : 'units'})
                  </label>
                  <input
                    type="number"
                    step={prodFormPricingUnit === 'PER_KG' ? 'any' : '1'}
                    min="0"
                    placeholder={prodFormPricingUnit === 'PER_KG' ? 'e.g. 25.0' : 'e.g. 50'}
                    value={prodFormInitialStock}
                    onChange={e => setProdFormInitialStock(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                  />
                  <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>
                    Creates an initial OPENING_STOCK movement in branch Madurai (IB).
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                <button
                  type="submit"
                  style={{
                    flex: 1,
                    padding: '10px 16px',
                    backgroundColor: '#8B1E2D',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  {editingProduct ? '✓ Save Product Changes' : '✓ Create & Add Product'}
                </button>
                <button
                  type="button"
                  onClick={() => setIsProductModalOpen(false)}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: '#eee',
                    border: '1px solid #ccc',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 7: Stock Movement & Adjustment Dialog                */}
      {/* ========================================================= */}
      {isStockAdjustModalOpen && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1250, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', border: '2px solid #8B1E2D', borderRadius: 10, width: 500, maxWidth: '95vw', padding: 24, boxShadow: '0 10px 30px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 10, marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, color: '#8B1E2D', fontSize: 17, fontWeight: 800 }}>
                  📊 Record Stock Movement / Adjustment
                </h3>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  Branch: {syncConfig?.branch_name || 'Iyer Bungalow Branch (IB)'} • Mandatory Reason Audited
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsStockAdjustModalOpen(false)}
                style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
              >
                ✕
              </button>
            </div>

            {adjustError && (
              <div style={{ backgroundColor: '#FFEBEE', color: '#C62828', padding: '10px 12px', borderRadius: 6, marginBottom: 14, fontSize: 12, border: '1px solid #FFCDD2' }}>
                ⚠️ {adjustError}
              </div>
            )}

            <form onSubmit={handleAdjustStockSubmit}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                  Select Product * (Search & Select)
                </label>
                {/* Search input */}
                <input
                  type="text"
                  placeholder="🔍 Type name, Tamil, or SKU to search products..."
                  value={adjustProductSearch}
                  onChange={e => setAdjustProductSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    fontSize: 13,
                    border: '1px solid #ccc',
                    borderRadius: 6,
                    boxSizing: 'border-box',
                    marginBottom: 6,
                  }}
                />

                {/* Filtered Search Results List */}
                <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid #E5E5DF', borderRadius: 6, backgroundColor: '#fff' }}>
                  {catalog
                    .filter(p => {
                      if (!adjustProductSearch.trim()) return true;
                      const q = adjustProductSearch.toLowerCase();
                      return (
                        p.name.toLowerCase().includes(q) ||
                        p.tamil_name.toLowerCase().includes(q) ||
                        p.sku.toLowerCase().includes(q)
                      );
                    })
                    .map(p => {
                      const isSelected = adjustProductId === p.id;
                      const stockStr = p.pricing_unit === 'PER_KG'
                        ? `${(p.current_stock / 1000000).toFixed(2)} kg`
                        : `${p.current_stock} ${p.stock_unit.toLowerCase()}`;
                      return (
                        <div
                          key={p.id}
                          onClick={() => setAdjustProductId(p.id)}
                          style={{
                            padding: '8px 10px',
                            cursor: 'pointer',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            borderBottom: '1px solid #f0f0f0',
                            backgroundColor: isSelected ? '#FFF3E0' : '#fff',
                            fontWeight: isSelected ? 700 : 400,
                          }}
                        >
                          <div>
                            <span style={{ color: isSelected ? '#8B1E2D' : '#1F1F1F', fontSize: 13 }}>
                              {isSelected ? '✓ ' : ''}{p.name}
                            </span>
                            <span style={{ fontSize: 11, color: '#666', marginLeft: 6 }}>
                              ({p.sku}) • {p.tamil_name}
                            </span>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 700, color: '#2E7D32' }}>
                            Stock: {stockStr}
                          </span>
                        </div>
                      );
                    })}
                </div>

                {/* Selected Product Banner */}
                {(() => {
                  const sel = catalog.find(p => p.id === adjustProductId);
                  if (!sel) return null;
                  const stockStr = sel.pricing_unit === 'PER_KG'
                    ? `${(sel.current_stock / 1000000).toFixed(2)} kg`
                    : `${sel.current_stock} ${sel.stock_unit.toLowerCase()}`;
                  return (
                    <div style={{ marginTop: 6, padding: '6px 10px', backgroundColor: '#F5F5F0', borderRadius: 6, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
                      <span><strong>Selected:</strong> {sel.name} ({sel.sku})</span>
                      <span style={{ color: '#8B1E2D', fontWeight: 700 }}>Current: {stockStr}</span>
                    </div>
                  );
                })()}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                    Movement Type *
                  </label>
                  <select
                    value={adjustMovementType}
                    onChange={e => setAdjustMovementType(e.target.value)}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', backgroundColor: '#fff' }}
                  >
                    <option value="RECEIPT_PRODUCTION">Kitchen Batch Receipt (+ In)</option>
                    <option value="RECEIPT_SUPPLIER">Supplier Delivery (+ In)</option>
                    <option value="WASTAGE_DAMAGE">Damaged / Dropped Goods (- Out)</option>
                    <option value="WASTAGE_EXPIRED">Expired / Shelf Life (- Out)</option>
                    <option value="RECONCILIATION_ADJUSTMENT">Physical Audit Discrepancy</option>
                    <option value="OPENING_STOCK">Opening Stock Provisioning (+ In)</option>
                  </select>
                </div>
                <div>
                  {(() => {
                    const curProd = catalog.find(p => p.id === adjustProductId);
                    const unitLabel = curProd?.pricing_unit === 'PER_KG' ? 'Quantity in Kg *' : 'Quantity in Units *';
                    return (
                      <>
                        <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                          {unitLabel}
                        </label>
                        <input
                          type="number"
                          step={curProd?.pricing_unit === 'PER_KG' ? 'any' : '1'}
                          min={curProd?.pricing_unit === 'PER_KG' ? '0.001' : '1'}
                          required
                          placeholder="e.g. 10"
                          value={adjustQuantity}
                          onChange={e => setAdjustQuantity(e.target.value)}
                          style={{ width: '100%', padding: '8px 10px', fontSize: 14, fontWeight: 700, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box' }}
                        />
                      </>
                    );
                  })()}
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#8B1E2D' }}>
                  Mandatory Audit Reason *
                </label>
                <textarea
                  required
                  rows={2}
                  placeholder="Required: State clearly why stock is being modified (e.g. Fresh morning production batch received from kitchen; Tray dropped during display setup; Monthly physical count reconciliation)..."
                  value={adjustReason}
                  onChange={e => setAdjustReason(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1.5px solid #8B1E2D', borderRadius: 6, boxSizing: 'border-box', resize: 'vertical' }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#333' }}>
                  Reference / Batch ID (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. BATCH-20261012-01 or PO-9842"
                  value={adjustReferenceId}
                  onChange={e => setAdjustReferenceId(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace' }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="submit"
                  style={{
                    flex: 1,
                    padding: '10px 16px',
                    backgroundColor: '#8B1E2D',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  ✓ Apply Stock Movement
                </button>
                <button
                  type="button"
                  onClick={() => setIsStockAdjustModalOpen(false)}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: '#eee',
                    border: '1px solid #ccc',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL 8: Void Sale / Return Confirmation Dialog           */}
      {/* ========================================================= */}
      {voidTargetSale && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.65)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1350, padding: 16 }}>
          <div style={{ backgroundColor: '#fff', border: '2px solid #C62828', borderRadius: 10, width: 480, maxWidth: '95vw', padding: 24, boxShadow: '0 12px 32px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #eee', paddingBottom: 10, marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0, color: '#C62828', fontSize: 17, fontWeight: 800 }}>
                  ⚠️ Void / Cancel Completed Invoice
                </h3>
                <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>
                  Admin Authorization • Inventory Restored to Stock
                </div>
              </div>
              <button
                type="button"
                onClick={() => setVoidTargetSale(null)}
                style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer', color: '#888' }}
              >
                ✕
              </button>
            </div>

            {voidError && (
              <div style={{ backgroundColor: '#FFEBEE', color: '#C62828', padding: '10px 12px', borderRadius: 6, marginBottom: 14, fontSize: 12, border: '1px solid #FFCDD2' }}>
                ⚠️ {voidError}
              </div>
            )}

            <div style={{ backgroundColor: '#FFF5F5', border: '1px solid #FFCDD2', borderRadius: 6, padding: 12, marginBottom: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: '#666' }}>Invoice Number:</span>
                <strong style={{ fontSize: 13, fontFamily: 'monospace' }}>{voidTargetSale.invoice_number}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: '#666' }}>Net Payable Amount:</span>
                <strong style={{ fontSize: 14, color: '#C62828' }}>₹{(voidTargetSale.net_payable_paise / 100).toFixed(2)}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: '#666' }}>Sale Timestamp:</span>
                <span style={{ fontSize: 12, color: '#444' }}>{new Date(voidTargetSale.created_at).toLocaleString()}</span>
              </div>
            </div>

            <div style={{ fontSize: 12, color: '#555', marginBottom: 14, lineHeight: 1.4 }}>
              <strong>Inventory & Cash Reversal Policy:</strong>
              <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                <li>Physical stock for all items will be automatically returned to store inventory.</li>
                <li>Audit records will be created with movement type <code style={{ color: '#2E7D32' }}>VOID_STOCK_REVERSAL</code>.</li>
                <li>Invoice status will become <strong>VOIDED</strong>; payment status becomes <strong>REFUNDED</strong>.</li>
              </ul>
            </div>

            <form onSubmit={handleVoidSaleSubmit}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: '#C62828' }}>
                  Mandatory Cancellation / Return Reason *
                </label>
                <textarea
                  required
                  rows={2}
                  placeholder="State the reason for voiding this invoice (e.g. Customer changed mind before leaving counter; Incorrect item billed; Returned due to quality complaint)..."
                  value={voidReason}
                  onChange={e => setVoidReason(e.target.value)}
                  style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1.5px solid #C62828', borderRadius: 6, boxSizing: 'border-box', resize: 'vertical' }}
                />
              </div>

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="submit"
                  style={{
                    flex: 1,
                    padding: '10px 16px',
                    backgroundColor: '#C62828',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: 'pointer',
                  }}
                >
                  Confirm Void & Reverse Inventory
                </button>
                <button
                  type="button"
                  onClick={() => setVoidTargetSale(null)}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: '#eee',
                    border: '1px solid #ccc',
                    borderRadius: 6,
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
