const Bill = require('../models/Bill');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { recordMovement } = require('../services/inventoryService');
const { getAccountByCode } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');

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

async function validateReferences({ supplier, items }) {
  const supplierDoc = await Supplier.findById(supplier);
  if (!supplierDoc) {
    const err = new Error('Selected supplier does not exist.');
    err.statusCode = 400;
    throw err;
  }

  const productIds = [...new Set(items.map((it) => String(it.product)))];
  const warehouseIds = [...new Set(items.map((it) => String(it.warehouse)))];

  const [products, warehouses] = await Promise.all([
    Product.find({ _id: { $in: productIds } }),
    Warehouse.find({ _id: { $in: warehouseIds } })
  ]);

  if (products.length !== productIds.length) {
    const err = new Error('One or more line items reference a product that does not exist.');
    err.statusCode = 400;
    throw err;
  }
  if (warehouses.length !== warehouseIds.length) {
    const err = new Error('One or more line items reference a warehouse that does not exist.');
    err.statusCode = 400;
    throw err;
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
      .populate('items.product', 'name sku unit')
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
    const { supplier, date, dueDate, items, notes, postNow } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });
    await validateReferences({ supplier, items });

    const totals = computeTotals(items);
    const billNumber = await nextNumber('bill', 'BILL');

    let bill = await Bill.create({
      billNumber,
      supplier,
      date,
      dueDate,
      items: totals.items,
      subTotal: totals.subTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      status: 'DRAFT',
      notes,
      createdBy: req.user._id
    });

    if (postNow) {
      bill = await postBill(bill._id, req.user._id);
    }

    const populated = await Bill.findById(bill._id).populate('supplier', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: 'Bill not found.' });
    if (bill.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only draft bills can be edited.' });
    }

    const { supplier, date, dueDate, items, notes, postNow } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });
    await validateReferences({ supplier, items });

    const totals = computeTotals(items);

    bill.supplier = supplier;
    bill.date = date;
    bill.dueDate = dueDate;
    bill.items = totals.items;
    bill.subTotal = totals.subTotal;
    bill.taxTotal = totals.taxTotal;
    bill.grandTotal = totals.grandTotal;
    bill.notes = notes;

    await bill.save();

    let result = bill;
    if (postNow) {
      result = await postBill(bill._id, req.user._id);
    }

    const populated = await Bill.findById(result._id).populate('supplier', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.post = async (req, res, next) => {
  try {
    const bill = await postBill(req.params.id, req.user._id);
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
    const err = new Error(existing ? 'Only draft bills can be posted.' : 'Bill not found.');
    err.statusCode = existing ? 400 : 404;
    throw err;
  }

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

    for (const item of bill.items) {
      const product = await Product.findById(item.product);
      const base = round2(item.quantity * item.unitCost);

      if (product && product.type === 'STOCK') {
        stockValue += base;
        await recordMovement({
          product: item.product,
          warehouse: item.warehouse,
          direction: 'IN',
          quantity: item.quantity,
          unitCost: item.unitCost,
          sourceType: 'BILL',
          sourceId: bill._id,
          note: `Bill ${bill.billNumber}`,
          createdBy: userId
        });
        // Purchasing at a new cost updates the product's cost price so the
        // next sale's COGS reflects what was actually paid for the stock on
        // hand (simple last-cost costing — see README's "scope" notes).
        product.costPrice = item.unitCost;
        await product.save();
      } else {
        expenseValue += base;
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

    const entry = await postJournal({
      date: bill.date,
      sourceType: 'BILL',
      sourceId: bill._id,
      reference: bill.billNumber,
      narration: `Purchase bill ${bill.billNumber}`,
      lines,
      createdBy: userId
    });

    bill.status = 'POSTED';
    bill.journalEntry = entry._id;
    await bill.save();
    return bill;
  } catch (err) {
    bill.status = 'DRAFT';
    await bill.save().catch(() => {});
    throw err;
  }
}

exports.void = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: 'Bill not found.' });
    if (bill.status === 'VOID') {
      return res.status(400).json({ message: 'This bill has already been voided.' });
    }
    if (bill.status === 'DRAFT') {
      return res.status(400).json({ message: 'Draft bills have nothing to void — delete them instead.' });
    }
    if (bill.amountPaid > 0) {
      return res.status(400).json({ message: 'Cannot void a bill that has payments allocated to it.' });
    }

    // Remove the stock that was added when the bill was posted. If it's
    // since been sold, this fails with an insufficient-stock error rather
    // than driving quantity negative — sell the stock back in first.
    for (const item of bill.items) {
      const product = await Product.findById(item.product);
      if (product && product.type === 'STOCK') {
        await recordMovement({
          product: item.product,
          warehouse: item.warehouse,
          direction: 'OUT',
          quantity: item.quantity,
          unitCost: item.unitCost,
          sourceType: 'BILL_VOID',
          sourceId: bill._id,
          note: `Void of bill ${bill.billNumber}`,
          createdBy: req.user._id
        });
      }
    }

    if (bill.journalEntry) {
      await reverseJournal(bill.journalEntry, { createdBy: req.user._id });
    }
    bill.status = 'VOID';
    await bill.save();
    res.json(bill);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: 'Bill not found.' });
    if (bill.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only draft bills can be deleted. Void it instead.' });
    }
    await bill.deleteOne();
    res.json({ message: 'Bill deleted.' });
  } catch (err) {
    next(err);
  }
};
