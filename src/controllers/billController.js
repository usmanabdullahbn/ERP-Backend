const Bill = require('../models/Bill');
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
    const lineTax = round2((lineBase * (it.taxRate || 0)) / 100);
    subTotal += lineBase;
    taxTotal += lineTax;
    return { ...it, lineTotal: round2(lineBase + lineTax) };
  });
  return { items: withLineTotal, subTotal: round2(subTotal), taxTotal: round2(taxTotal), grandTotal: round2(subTotal + taxTotal) };
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

    const totals = computeTotals(items);
    const billNumber = await nextNumber('bill', 'BILL');

    const bill = await Bill.create({
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
      await postBill(bill, req.user._id);
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

    if (postNow) {
      await postBill(bill, req.user._id);
    }

    const populated = await Bill.findById(bill._id).populate('supplier', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.post = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: 'Bill not found.' });
    if (bill.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only draft bills can be posted.' });
    }
    await postBill(bill, req.user._id);
    res.json(bill);
  } catch (err) {
    next(err);
  }
};

async function postBill(bill, userId) {
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
    const Product = require('../models/Product');
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
}

exports.void = async (req, res, next) => {
  try {
    const bill = await Bill.findById(req.params.id);
    if (!bill) return res.status(404).json({ message: 'Bill not found.' });
    if (bill.amountPaid > 0) {
      return res.status(400).json({ message: 'Cannot void a bill that has payments allocated to it.' });
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
