const Bill = require('../models/Bill');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const Payment = require('../models/Payment');
const PurchaseOrder = require('../models/PurchaseOrder');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { recordMovement, rollbackMovements } = require('../services/inventoryService');
const { withTransaction, httpError } = require('../services/transaction');
const { getAccountByCode } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');

// Statuses whose stock and journal are live and must be reversed on edit/delete.
const POSTED_STATUSES = ['POSTED', 'PARTIALLY_PAID', 'PAID'];

function computeTotals(items) {
  let subTotal = 0;
  let taxTotal = 0;
  const withLineTotal = items.map((it) => {
    const lineBase = round2(it.quantity * it.unitCost);
    const discountAmount = round2((lineBase * (it.discountRate || 0)) / 100);
    const taxableBase = round2(lineBase - discountAmount);
    const lineTax = round2((taxableBase * (it.taxRate || 0)) / 100);
    subTotal += taxableBase;
    taxTotal += lineTax;
    return { ...it, discountRate: Number(it.discountRate || 0), lineTotal: round2(taxableBase + lineTax) };
  });
  return { items: withLineTotal, subTotal: round2(subTotal), taxTotal: round2(taxTotal), grandTotal: round2(subTotal + taxTotal) };
}

// Line value after discount, before tax — must match computeTotals so the
// journal debits add up to the AP credit (grandTotal).
function netLineBase(item) {
  const lineBase = round2(item.quantity * item.unitCost);
  return round2(lineBase - round2((lineBase * (item.discountRate || 0)) / 100));
}

function netUnitCost(item) {
  return item.quantity ? netLineBase(item) / item.quantity : 0;
}

async function validateReferences({ supplier, items }) {
  const supplierDoc = await Supplier.findById(supplier);
  if (!supplierDoc) throw httpError(400, 'Selected supplier does not exist.');

  const productIds = [...new Set(items.map((it) => String(it.product)))];
  const warehouseIds = [...new Set(items.map((it) => String(it.warehouse)))];

  // Sequential, not Promise.all: this also runs inside transactions.
  const products = await Product.find({ _id: { $in: productIds } });
  const warehouses = await Warehouse.find({ _id: { $in: warehouseIds } });

  if (products.length !== productIds.length) throw httpError(400, 'One or more line items reference a product that does not exist.');
  if (warehouses.length !== warehouseIds.length) throw httpError(400, 'One or more line items reference a warehouse that does not exist.');
}

/*
  Takes back out the stock a posted bill brought in, at the cost it came in
  at, so the stock value removed matches what the journal reversal takes off
  Inventory. Fails with an insufficient-stock error if it's since been sold
  (the surrounding transaction then undoes everything).
*/
async function removeBillStock(bill, userId, note) {
  for (const item of bill.items) {
    const product = await Product.findById(item.product);
    if (!product || product.type !== 'STOCK') continue;
    await recordMovement({
      product: item.product,
      warehouse: item.warehouse,
      direction: 'OUT',
      quantity: item.quantity,
      unitCost: netUnitCost(item),
      sourceType: 'BILL_VOID',
      sourceId: bill._id,
      note,
      createdBy: userId
    });
  }
}

exports.list = async (req, res, next) => {
  try {
    const { status, supplier } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (supplier) filter.supplier = supplier;
    const bills = await Bill.find(filter).populate('supplier', 'name code').sort({ date: -1 });
    res.json(bills);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate('supplier')
      .populate('items.product', 'name sku unit altUnit altUnitFactor')
      .populate('items.warehouse', 'name code')
      .populate('journalEntry');
    if (!bill) return res.status(404).json({ message: 'Bill not found.' });
    res.json(bill);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { supplier, date, dueDate, docRef, paymentTerms, items, notes, postNow } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });

    const billId = await withTransaction(async () => {
      await validateReferences({ supplier, items });
      const totals = computeTotals(items);
      const billNumber = await nextNumber('bill', 'BILL');

      const [bill] = await Bill.create([{
        billNumber,
        supplier,
        date,
        dueDate,
        docRef,
        paymentTerms,
        items: totals.items,
        subTotal: totals.subTotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        status: 'DRAFT',
        notes,
        createdBy: req.user._id
      }]);

      if (postNow) await postBill(bill._id, req.user._id);
      return bill._id;
    });

    const populated = await Bill.findById(billId).populate('supplier', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { supplier, date, dueDate, docRef, paymentTerms, items, notes, postNow } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });

    const billId = await withTransaction(async () => {
      const bill = await Bill.findById(req.params.id);
      if (!bill) throw httpError(404, 'Bill not found.');
      if (bill.status === 'POSTING') throw httpError(400, 'Bill is currently being posted. Try again shortly.');
      if (await Payment.exists({ 'allocations.bill': bill._id })) {
        throw httpError(400, 'This bill has payments allocated to it. Delete those payments first.');
      }

      // Validate the new content before touching the posted stock and journal,
      // so a rejected edit leaves the bill exactly as it was.
      await validateReferences({ supplier, items });
      const totals = computeTotals(items);

      // For posted bills (including paid ones), reverse existing journal and stock entries before applying edits
      if (POSTED_STATUSES.includes(bill.status)) {
        await removeBillStock(bill, req.user._id, `Admin edit reversal of ${bill.billNumber}`);
        if (bill.journalEntry) {
          await reverseJournal(bill.journalEntry, { createdBy: req.user._id });
          bill.journalEntry = null;
        }
        bill.status = 'DRAFT';
      } else if (bill.status === 'VOID') {
        // Void already reversed journal and stock — just reset to DRAFT
        bill.status = 'DRAFT';
        bill.journalEntry = null;
      }

      bill.supplier = supplier;
      bill.date = date;
      bill.dueDate = dueDate;
      bill.docRef = docRef;
      bill.paymentTerms = paymentTerms;
      bill.items = totals.items;
      bill.subTotal = totals.subTotal;
      bill.taxTotal = totals.taxTotal;
      bill.grandTotal = totals.grandTotal;
      bill.notes = notes;
      await bill.save();

      if (postNow) await postBill(bill._id, req.user._id);
      return bill._id;
    });

    const populated = await Bill.findById(billId).populate('supplier', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.post = async (req, res, next) => {
  try {
    const bill = await withTransaction(() => postBill(req.params.id, req.user._id));
    res.json(bill);
  } catch (err) {
    next(err);
  }
};

/* See invoiceController.postInvoice for why the DRAFT -> POSTING claim is atomic. */
async function postBill(billId, userId) {
  const bill = await Bill.findOneAndUpdate(
    { _id: billId, status: 'DRAFT' },
    { status: 'POSTING' },
    { new: true }
  );
  if (!bill) {
    const existing = await Bill.findById(billId);
    throw httpError(existing ? 400 : 404, existing ? 'Only draft bills can be posted.' : 'Bill not found.');
  }

  // A failed attempt must leave nothing behind: stock it added and any
  // journal it created are undone in the catch, so a retry can't double the
  // stock. (Inside a transaction the abort undoes it anyway; this covers the
  // WhatsApp path, which posts outside one.)
  const startedAt = new Date();
  let entry = null;

  try {
    const ap = await getAccountByCode(SYS.ACCOUNTS_PAYABLE);
    const inventoryAsset = await getAccountByCode(SYS.INVENTORY_ASSET);
    const inputTax = await getAccountByCode(SYS.INPUT_TAX_RECEIVABLE);
    const purchasesExpense = await getAccountByCode(SYS.PURCHASES_EXPENSE);

    const lines = [
      { account: ap._id, debit: 0, credit: bill.grandTotal, memo: `Bill ${bill.billNumber}` }
    ];

    let stockValue = 0;
    let expenseValue = 0;
    const stockItems = [];

    for (const item of bill.items) {
      const product = await Product.findById(item.product);
      const base = netLineBase(item);

      if (product && product.type === 'STOCK') {
        stockValue = round2(stockValue + base);
        stockItems.push(item);
      } else {
        expenseValue = round2(expenseValue + base);
      }
    }

    if (stockValue > 0) {
      lines.push({ account: inventoryAsset._id, debit: stockValue, credit: 0, memo: `Bill ${bill.billNumber}` });
    }
    if (expenseValue > 0) {
      lines.push({ account: purchasesExpense._id, debit: expenseValue, credit: 0, memo: `Bill ${bill.billNumber}` });
    }
    if (bill.taxTotal > 0) {
      lines.push({ account: inputTax._id, debit: bill.taxTotal, credit: 0, memo: `Input tax ${bill.billNumber}` });
    }

    // Journal first: postJournal rejects an unbalanced entry before any
    // stock has been touched.
    entry = await postJournal({
      date: bill.date,
      sourceType: 'BILL',
      sourceId: bill._id,
      reference: bill.billNumber,
      narration: `Purchase bill ${bill.billNumber}`,
      lines,
      createdBy: userId
    });

    // Stock comes in at its net cost; recordMovement blends that into the
    // product's weighted-average cost, which COGS and the stock report use.
    for (const item of stockItems) {
      await recordMovement({
        product: item.product,
        warehouse: item.warehouse,
        direction: 'IN',
        quantity: item.quantity,
        unitCost: netUnitCost(item),
        sourceType: 'BILL',
        sourceId: bill._id,
        note: `Bill ${bill.billNumber}`,
        createdBy: userId
      });
    }

    bill.status = 'POSTED';
    bill.journalEntry = entry._id;
    await bill.save();
    return bill;
  } catch (err) {
    await rollbackMovements({ sourceType: 'BILL', sourceId: bill._id, since: startedAt }).catch(() => {});
    if (entry) await reverseJournal(entry._id, { createdBy: userId }).catch(() => {});
    bill.status = 'DRAFT';
    bill.journalEntry = null;
    await bill.save().catch(() => {});
    throw err;
  }
}

exports.void = async (req, res, next) => {
  try {
    const bill = await withTransaction(async () => {
      const bill = await Bill.findById(req.params.id);
      if (!bill) throw httpError(404, 'Bill not found.');
      if (bill.status === 'VOID') throw httpError(400, 'This bill has already been voided.');
      if (bill.status === 'DRAFT') throw httpError(400, 'Draft bills have nothing to void — delete them instead.');
      if (bill.status === 'POSTING') throw httpError(400, 'Bill is currently being posted. Try again shortly.');
      if (bill.amountPaid > 0) throw httpError(400, 'Cannot void a bill that has payments allocated to it.');

      // Remove the stock that was added when the bill was posted. If it's
      // since been sold, this fails with an insufficient-stock error and the
      // transaction leaves everything untouched — sell the stock back in first.
      await removeBillStock(bill, req.user._id, `Void of bill ${bill.billNumber}`);

      if (bill.journalEntry) {
        await reverseJournal(bill.journalEntry, { createdBy: req.user._id });
      }
      bill.status = 'VOID';
      await bill.save();
      return bill;
    });
    res.json(bill);
  } catch (err) {
    next(err);
  }
};

exports.postBill = postBill;

exports.remove = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const bill = await Bill.findById(req.params.id);
      if (!bill) throw httpError(404, 'Bill not found.');
      if (bill.status === 'POSTING') throw httpError(400, 'Bill is currently being posted. Try again shortly.');
      if (await Payment.exists({ 'allocations.bill': bill._id })) {
        throw httpError(400, 'This bill has payments allocated to it. Delete those payments first.');
      }

      // For posted bills (including paid ones), reverse journal and stock entries before deleting
      if (POSTED_STATUSES.includes(bill.status)) {
        await removeBillStock(bill, req.user._id, `Admin deletion of bill ${bill.billNumber}`);
        if (bill.journalEntry) {
          await reverseJournal(bill.journalEntry, { createdBy: req.user._id });
        }
      }
      // VOID bills already have their journal and stock reversed — safe to delete directly

      // A purchase order converted into this bill becomes open again, so it can be re-billed.
      await PurchaseOrder.updateMany({ bill: bill._id }, { bill: null, amountBilled: 0, status: 'OPEN' });
      await bill.deleteOne();
    });
    res.json({ message: 'Bill deleted.' });
  } catch (err) {
    next(err);
  }
};
