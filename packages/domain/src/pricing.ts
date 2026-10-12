import { ProductDefinition, SaleItemAllocation } from '@malgudi/contracts';

/**
 * Standard Indian Commercial Accounting Half-Up Rounding to Integer Paise.
 */
export function roundHalfUp(value: number): number {
  return Math.round(value + Number.EPSILON);
}

export interface CalculateLineItemParams {
  product: ProductDefinition;
  quantityInput: number; // mg for weight, count for units/dozens
  weightInputSource?: 'SCALE_AUTO' | 'MANUAL_KEYPAD';
  isInterstate?: boolean;
}

export function calculateLineItem(params: CalculateLineItemParams): SaleItemAllocation {
  const { product, quantityInput, weightInputSource = 'SCALE_AUTO', isInterstate = false } = params;

  let baseAmountPaise = 0;
  let stockDelta = 0;
  const stockUnit = product.inventory_unit;

  switch (product.pricing_unit) {
    case 'PER_KG': {
      // quantityInput is in integer milligrams (mg). 1 kg = 1,000,000 mg
      if (quantityInput <= 0) throw new Error('Weighed quantity must be positive');
      baseAmountPaise = roundHalfUp((quantityInput * product.base_price_paise) / 1_000_000);
      stockDelta = -quantityInput; // Deducts mg
      break;
    }
    case 'PER_PIECE': {
      if (quantityInput <= 0 || !Number.isInteger(quantityInput)) {
        throw new Error('Piece quantity must be a positive integer');
      }
      baseAmountPaise = quantityInput * product.base_price_paise;
      stockDelta = -quantityInput; // Deducts pieces
      break;
    }
    case 'PER_PACK':
    case 'PER_BOX': {
      if (quantityInput <= 0 || !Number.isInteger(quantityInput)) {
        throw new Error('Pack/Box quantity must be a positive integer');
      }
      baseAmountPaise = quantityInput * product.base_price_paise;
      stockDelta = -quantityInput; // Deducts packs or boxes
      break;
    }
    case 'PER_DOZEN': {
      // If sold by the dozen, quantityInput represents count of dozens.
      // 1 dozen = 12 pieces in inventory.
      if (quantityInput <= 0) throw new Error('Dozen quantity must be positive');
      baseAmountPaise = roundHalfUp(quantityInput * product.base_price_paise);
      stockDelta = -roundHalfUp(quantityInput * 12); // Deducts base pieces
      break;
    }
  }

  // Tax Extraction
  let taxablePaise = 0;
  let totalTaxPaise = 0;
  let grossPaise = 0;

  if (product.pricing_basis === 'TAX_INCLUSIVE') {
    grossPaise = baseAmountPaise;
    taxablePaise = roundHalfUp((grossPaise * 10000) / (10000 + product.tax_rate_bps));
    totalTaxPaise = grossPaise - taxablePaise;
  } else {
    taxablePaise = baseAmountPaise;
    totalTaxPaise = roundHalfUp((taxablePaise * product.tax_rate_bps) / 10000);
    grossPaise = taxablePaise + totalTaxPaise;
  }

  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  if (isInterstate) {
    igstPaise = totalTaxPaise;
  } else {
    cgstPaise = Math.floor(totalTaxPaise / 2);
    sgstPaise = totalTaxPaise - cgstPaise;
  }

  return {
    id: `item_${Math.random().toString(36).slice(2, 10)}`,
    product_id: product.id,
    quantity_input: quantityInput,
    pricing_unit: product.pricing_unit,
    weight_input_source: weightInputSource,
    unit_price_paise: product.base_price_paise,
    taxable_paise: taxablePaise,
    cgst_paise: cgstPaise,
    sgst_paise: sgstPaise,
    igst_paise: igstPaise,
    total_tax_paise: totalTaxPaise,
    gross_paise: grossPaise,
    stock_deduction_delta: stockDelta,
    stock_unit: stockUnit,
  };
}

/**
 * Calculates pieces sold individually from a product configured per-dozen.
 */
export function calculatePiecesFromDozenSku(
  product: ProductDefinition,
  pieceCount: number,
  isInterstate = false
): SaleItemAllocation {
  if (product.pricing_unit !== 'PER_DOZEN') {
    throw new Error('Product must have pricing_unit PER_DOZEN');
  }
  if (pieceCount <= 0 || !Number.isInteger(pieceCount)) {
    throw new Error('Piece count must be a positive integer');
  }

  // Determine piece price: independent piece price if configured, else derived
  const piecePricePaise = product.piece_price_paise ?? roundHalfUp(product.base_price_paise / 12);
  const baseAmountPaise = pieceCount * piecePricePaise;
  const stockDelta = -pieceCount; // Deducts exact pieces

  let taxablePaise = 0;
  let totalTaxPaise = 0;
  let grossPaise = 0;

  if (product.pricing_basis === 'TAX_INCLUSIVE') {
    grossPaise = baseAmountPaise;
    taxablePaise = roundHalfUp((grossPaise * 10000) / (10000 + product.tax_rate_bps));
    totalTaxPaise = grossPaise - taxablePaise;
  } else {
    taxablePaise = baseAmountPaise;
    totalTaxPaise = roundHalfUp((taxablePaise * product.tax_rate_bps) / 10000);
    grossPaise = taxablePaise + totalTaxPaise;
  }

  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  if (isInterstate) {
    igstPaise = totalTaxPaise;
  } else {
    cgstPaise = Math.floor(totalTaxPaise / 2);
    sgstPaise = totalTaxPaise - cgstPaise;
  }

  return {
    id: `item_${Math.random().toString(36).slice(2, 10)}`,
    product_id: product.id,
    quantity_input: pieceCount,
    pricing_unit: 'PER_PIECE',
    weight_input_source: 'SCALE_AUTO',
    unit_price_paise: piecePricePaise,
    taxable_paise: taxablePaise,
    cgst_paise: cgstPaise,
    sgst_paise: sgstPaise,
    igst_paise: igstPaise,
    total_tax_paise: totalTaxPaise,
    gross_paise: grossPaise,
    stock_deduction_delta: stockDelta,
    stock_unit: 'PIECE',
  };
}

export interface InvoiceTotals {
  subtotal_taxable_paise: number;
  total_cgst_paise: number;
  total_sgst_paise: number;
  total_igst_paise: number;
  total_gross_paise: number;
  round_off_paise: number;
  net_payable_paise: number;
}

export function calculateInvoiceTotals(items: SaleItemAllocation[]): InvoiceTotals {
  let subtotal_taxable_paise = 0;
  let total_cgst_paise = 0;
  let total_sgst_paise = 0;
  let total_igst_paise = 0;
  let total_gross_paise = 0;

  for (const item of items) {
    subtotal_taxable_paise += item.taxable_paise;
    total_cgst_paise += item.cgst_paise;
    total_sgst_paise += item.sgst_paise;
    total_igst_paise += item.igst_paise;
    total_gross_paise += item.gross_paise;
  }

  // Section 170 CGST Act: Round off to nearest rupee
  const nearestRupeeInPaise = Math.round(total_gross_paise / 100) * 100;
  const round_off_paise = nearestRupeeInPaise - total_gross_paise;
  const net_payable_paise = nearestRupeeInPaise;

  return {
    subtotal_taxable_paise,
    total_cgst_paise,
    total_sgst_paise,
    total_igst_paise,
    total_gross_paise,
    round_off_paise,
    net_payable_paise,
  };
}
