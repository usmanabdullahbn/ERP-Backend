const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { recordMovement } = require('../services/inventoryService');
const { getAccountByCode } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');

function computeTotals(items) {
  let subTotal = 0;
  let taxTotal = 0;
  const withLineTotal = items.map((it) => {
    const lineBase = round2(it.quantity * it.unitPrice);
    const lineTax = round2((lineBase * (it.taxRate || 0)) / 100);
    subTotal += lineBase;
    taxTotal += lineTax;
    return { ...it, lineTotal: round2(lineBase + lineTax) };
  });
  return { items: withLineTotal, subTotal: round2(subTotal), taxTotal: round2(taxTotal), grandTotal: round2(subTotal + taxTotal) };
}

exports.list = async (req, res, next) => {
  try {
    const { status, customer } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (customer) filter.customer = customer;
    const invoices = await Invoice.find(filter).populate('customer', 'name code').sort({ date: -1 });
    res.json(invoices);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id)
      .populate('customer')
      .populate('items.product', 'name sku unit')
      .populate('items.warehouse', 'name code')
      .populate('journalEntry');
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    res.json(invoice);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { customer, date, dueDate, items, notes, postNow } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });

    const totals = computeTotals(items);
    const invoiceNumber = await nextNumber('invoice', 'INV');

    const invoice = await Invoice.create({
      invoiceNumber,
      customer,
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
      await postInvoice(invoice, req.user._id);
    }

    const populated = await Invoice.findById(invoice._id).populate('customer', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    if (invoice.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only draft invoices can be edited.' });
    }

    const { customer, date, dueDate, items, notes, postNow } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });

    const totals = computeTotals(items);

    invoice.customer = customer;
    invoice.date = date;
    invoice.dueDate = dueDate;
    invoice.items = totals.items;
    invoice.subTotal = totals.subTotal;
    invoice.taxTotal = totals.taxTotal;
    invoice.grandTotal = totals.grandTotal;
    invoice.notes = notes;

    await invoice.save();

    if (postNow) {
      await postInvoice(invoice, req.user._id);
    }

    const populated = await Invoice.findById(invoice._id).populate('customer', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.post = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    if (invoice.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only draft invoices can be posted.' });
    }
    await postInvoice(invoice, req.user._id);
    res.json(invoice);
  } catch (err) {
    next(err);
  }
};

async function postInvoice(invoice, userId) {
  const ar = await getAccountByCode(SYS.ACCOUNTS_RECEIVABLE);
  const salesRevenue = await getAccountByCode(SYS.SALES_REVENUE);
  const salesTaxPayable = await getAccountByCode(SYS.SALES_TAX_PAYABLE);
  const inventoryAsset = await getAccountByCode(SYS.INVENTORY_ASSET);
  const cogs = await getAccountByCode(SYS.COST_OF_GOODS_SOLD);

  const lines = [
    { account: ar._id, debit: invoice.grandTotal, credit: 0, memo: `Invoice ${invoice.invoiceNumber}` },
    { account: salesRevenue._id, debit: 0, credit: invoice.subTotal, memo: `Invoice ${invoice.invoiceNumber}` }
  ];
  if (invoice.taxTotal > 0) {
    lines.push({ account: salesTaxPayable._id, debit: 0, credit: invoice.taxTotal, memo: `Output tax ${invoice.invoiceNumber}` });
  }

  // COGS + inventory reduction for stock items
  let totalCost = 0;
  for (const item of invoice.items) {
    const product = await Product.findById(item.product);
    if (product && product.type === 'STOCK') {
      const cost = round2((product.costPrice || 0) * item.quantity);
      totalCost += cost;
      await recordMovement({
        product: item.product,
        warehouse: item.warehouse,
        direction: 'OUT',
        quantity: item.quantity,
        unitCost: product.costPrice,
        sourceType: 'INVOICE',
        sourceId: invoice._id,
        note: `Invoice ${invoice.invoiceNumber}`,
        createdBy: userId
      });
    }
  }
  if (totalCost > 0) {
    lines.push({ account: cogs._id, debit: totalCost, credit: 0, memo: `COGS ${invoice.invoiceNumber}` });
    lines.push({ account: inventoryAsset._id, debit: 0, credit: totalCost, memo: `COGS ${invoice.invoiceNumber}` });
  }

  const entry = await postJournal({
    date: invoice.date,
    sourceType: 'INVOICE',
    sourceId: invoice._id,
    reference: invoice.invoiceNumber,
    narration: `Sales invoice ${invoice.invoiceNumber}`,
    lines,
    createdBy: userId
  });

  invoice.status = 'POSTED';
  invoice.journalEntry = entry._id;
  await invoice.save();
  return invoice;
}

exports.void = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    if (invoice.amountPaid > 0) {
      return res.status(400).json({ message: 'Cannot void an invoice that has receipts allocated to it.' });
    }
    if (invoice.journalEntry) {
      await reverseJournal(invoice.journalEntry, { createdBy: req.user._id });
    }
    invoice.status = 'VOID';
    await invoice.save();
    res.json(invoice);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

    const isAdmin = req.user?.role?.permissions?.includes('*') || req.user?.role?.name === 'Admin' || req.user?.role === 'Admin';
    if (invoice.status !== 'DRAFT' && !isAdmin) {
      return res.status(400).json({ message: 'Only draft invoices can be deleted. Admins can delete non-draft invoices.' });
    }

    await invoice.deleteOne();
    res.json({ message: 'Invoice deleted.' });
  } catch (err) {
    next(err);
  }
};
