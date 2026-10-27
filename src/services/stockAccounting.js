const Product = require('../models/Product');
const { recordMovement } = require('./inventoryService');
const { postJournal, round2 } = require('./ledgerService');
const { getAccountByCode, getOrCreateSystemAccount } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');
const { httpError } = require('./transaction');

/*
  Stock movements that aren't part of a sales/purchase document (opening
  stock, manual adjustments) still change what the stock is worth, so each
  one also posts a journal: Inventory against Opening Balance Equity for
  opening stock, or against Inventory Adjustments for everything else. This
  keeps the Inventory account equal to the stock report. Valued at the
  product's average cost unless a cost is given.
*/
async function moveStockWithJournal({ product, warehouse, direction, quantity, unitCost, sourceType, sourceId, note, createdBy, date }) {
  const productDoc = await Product.findById(product);
  if (!productDoc) throw httpError(404, 'Product not found.');
  const cost = unitCost ?? productDoc.costPrice ?? 0;
  const isIn = String(direction || '').toUpperCase() === 'IN';

  const updated = await recordMovement({ product, warehouse, direction, quantity, unitCost: cost, sourceType, sourceId, note, createdBy, date });

  const value = round2(Number(quantity) * cost);
  if (productDoc.type === 'STOCK' && value > 0) {
    const inventory = await getAccountByCode(SYS.INVENTORY_ASSET);
    const contra = sourceType === 'OPENING_STOCK'
      ? await getAccountByCode(SYS.OPENING_BALANCE_EQUITY)
      : await getOrCreateSystemAccount(SYS.INVENTORY_ADJUSTMENT, {
        name: 'Inventory Adjustments',
        namePattern: /adjust/i,
        type: 'EXPENSE',
        subType: 'Operating Expense',
        normalBalance: 'debit'
      });
    const memo = `${productDoc.sku} ${productDoc.name} — ${isIn ? 'in' : 'out'} ${quantity}`;
    await postJournal({
      date: date || new Date(),
      sourceType: sourceType === 'OPENING_STOCK' ? 'OPENING_STOCK' : 'STOCK_ADJUSTMENT',
      sourceId: sourceId || productDoc._id,
      reference: productDoc.sku,
      narration: note || (sourceType === 'OPENING_STOCK' ? 'Opening stock' : 'Stock adjustment'),
      lines: isIn
        ? [{ account: inventory._id, debit: value, credit: 0, memo }, { account: contra._id, debit: 0, credit: value, memo }]
        : [{ account: contra._id, debit: value, credit: 0, memo }, { account: inventory._id, debit: 0, credit: value, memo }],
      createdBy
    });
  }
  return updated;
}

module.exports = { moveStockWithJournal };
