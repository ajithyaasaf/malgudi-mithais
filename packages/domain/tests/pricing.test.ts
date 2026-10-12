import { describe, it, expect } from 'vitest';
import { 
  calculateLineItem, 
  calculatePiecesFromDozenSku, 
  calculateInvoiceTotals, 
  roundHalfUp 
} from '../src/pricing.js';
import { ProductDefinition } from '@malgudi/contracts';

describe('Pricing Engine & Precision Invariants (SC-01 & SC-02)', () => {
  const mysorePak: ProductDefinition = {
    id: 'prod_mysore_pak',
    name: 'Special Ghee Mysore Pak',
    tamil_name: 'நெய் மைசூர் பாக்',
    sku: 'MP-001',
    category_id: 'cat_sweets',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 68000, // ₹680.00 / kg
    tax_rate_bps: 500, // 5% GST
    hsn_code: '21069099',
    is_active: true,
  };

  const sweetBunDozen: ProductDefinition = {
    id: 'prod_sweet_bun',
    name: 'Butter Sweet Bun',
    tamil_name: 'ஸ்வீட் பன்',
    sku: 'SB-012',
    category_id: 'cat_bakery',
    pricing_unit: 'PER_DOZEN',
    inventory_unit: 'PIECE',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 24000, // ₹240.00 / dozen
    piece_price_paise: 2200, // ₹22.00 / piece (independent piece price)
    tax_rate_bps: 500,
    hsn_code: '19059090',
    is_active: true,
  };

  const plainBreadExempt: ProductDefinition = {
    id: 'prod_milk_bread',
    name: 'Fresh Milk Bread',
    tamil_name: 'பிரெட்',
    sku: 'BR-001',
    category_id: 'cat_bakery',
    pricing_unit: 'PER_PIECE',
    inventory_unit: 'PIECE',
    pricing_basis: 'TAX_INCLUSIVE',
    base_price_paise: 4500, // ₹45.00 / piece
    tax_rate_bps: 0, // 0% Nil-rated
    hsn_code: '1905',
    is_active: true,
  };

  const chocolateCakeExclusive: ProductDefinition = {
    id: 'prod_custom_cake',
    name: 'Belgian Chocolate Cake',
    tamil_name: 'சாக்லேட் கேக்',
    sku: 'CK-001',
    category_id: 'cat_cakes',
    pricing_unit: 'PER_KG',
    inventory_unit: 'MG',
    pricing_basis: 'TAX_EXCLUSIVE',
    base_price_paise: 80000, // ₹800.00 / kg before tax
    tax_rate_bps: 1800, // 18% GST
    hsn_code: '19059010',
    is_active: true,
  };

  it('SC-01: Exactly calculates 375g Mysore Pak @ ₹680/kg tax-inclusive', () => {
    // 375 grams = 375,000 mg
    const line = calculateLineItem({
      product: mysorePak,
      quantityInput: 375000,
      weightInputSource: 'SCALE_AUTO',
    });

    // Gross: (375000 * 68000) / 1,000,000 = 25,500 paise (₹255.00)
    expect(line.gross_paise).toBe(25500);

    // Taxable: round((25500 * 10000) / 10500) = round(24285.714) = 24,286 paise (₹242.86)
    expect(line.taxable_paise).toBe(24286);

    // Total Tax: 25500 - 24286 = 1,214 paise (₹12.14)
    expect(line.total_tax_paise).toBe(1214);

    // CGST: floor(1214 / 2) = 607 paise (₹6.07)
    expect(line.cgst_paise).toBe(607);

    // SGST: 1214 - 607 = 607 paise (₹6.07)
    expect(line.sgst_paise).toBe(607);
    expect(line.igst_paise).toBe(0);

    // Stock Deduction: exactly -375000 mg
    expect(line.stock_deduction_delta).toBe(-375000);
    expect(line.stock_unit).toBe('MG');
  });

  it('SC-02: Per-Dozen Pricing and Stock Deduction Equivalence', () => {
    // 1. Sell 1 dozen sweet buns
    const dozenSale = calculateLineItem({
      product: sweetBunDozen,
      quantityInput: 1, // 1 dozen
    });
    expect(dozenSale.gross_paise).toBe(24000); // ₹240.00
    expect(dozenSale.stock_deduction_delta).toBe(-12); // Deducts 12 pieces
    expect(dozenSale.stock_unit).toBe('PIECE');

    // 2. Sell 12 individual sweet buns with independent piece price (₹22/pc)
    const twelvePiecesSale = calculatePiecesFromDozenSku(sweetBunDozen, 12);
    expect(twelvePiecesSale.gross_paise).toBe(26400); // 12 * ₹22 = ₹264.00
    expect(twelvePiecesSale.stock_deduction_delta).toBe(-12); // Deducts 12 pieces

    // Stock deductions are exactly identical (-12 pieces)
    expect(dozenSale.stock_deduction_delta).toBe(twelvePiecesSale.stock_deduction_delta);

    // Financial difference: ₹264.00 - ₹240.00 = ₹24.00 bulk discount
    expect(twelvePiecesSale.gross_paise - dozenSale.gross_paise).toBe(2400);

    // 3. Derived Piece Price mode (when piece_price_paise is undefined)
    const derivedSku: ProductDefinition = {
      ...sweetBunDozen,
      piece_price_paise: undefined,
    };
    const derivedSale = calculatePiecesFromDozenSku(derivedSku, 12);
    // Derived price per piece: round(24000 / 12) = 2000 paise (₹20.00)
    expect(derivedSale.gross_paise).toBe(24000); // 12 * ₹20.00 = ₹240.00
    expect(derivedSale.stock_deduction_delta).toBe(-12);
    expect(derivedSale.gross_paise).toBe(dozenSale.gross_paise);
  });

  it('Mixed Tax Rates on Single Invoice with Section 170 CGST Act Round-Off', () => {
    // Cart:
    // 1. 375g Mysore Pak (5% incl) -> ₹255.00
    const item1 = calculateLineItem({ product: mysorePak, quantityInput: 375000 });
    // 2. 1 Fresh Milk Bread (0% exempt) -> ₹45.00
    const item2 = calculateLineItem({ product: plainBreadExempt, quantityInput: 1 });
    // 3. 500g Chocolate Cake (18% excl) -> Base ₹400 + 18% tax ₹72 = ₹472.00
    const item3 = calculateLineItem({ product: chocolateCakeExclusive, quantityInput: 500000 });

    expect(item2.gross_paise).toBe(4500);
    expect(item2.taxable_paise).toBe(4500);
    expect(item2.total_tax_paise).toBe(0);

    expect(item3.taxable_paise).toBe(40000); // ₹400.00
    expect(item3.total_tax_paise).toBe(7200); // 18% of 400 = ₹72.00
    expect(item3.gross_paise).toBe(47200); // ₹472.00
    expect(item3.cgst_paise).toBe(3600);
    expect(item3.sgst_paise).toBe(3600);

    const totals = calculateInvoiceTotals([item1, item2, item3]);
    // Gross sum: 25500 + 4500 + 47200 = 77,200 paise (₹772.00)
    expect(totals.total_gross_paise).toBe(77200);
    expect(totals.round_off_paise).toBe(0);
    expect(totals.net_payable_paise).toBe(77200);
  });
});
