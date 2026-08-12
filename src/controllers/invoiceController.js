const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Warehouse = require('../models/Warehouse');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { recordMovement } = require('../services/inventoryService');
const StockMovement = require('../models/StockMovement');
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

/* Rejects an invoice payload that references a customer/product/warehouse that doesn't exist. */
async function validateReferences({ customer, items }) {
  const customerDoc = await Customer.findById(customer);
  if (!customerDoc) {
    const err = new Error('Selected customer does not exist.');
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
    await validateReferences({ customer, items });

    const totals = computeTotals(items);
    const invoiceNumber = await nextNumber('invoice', 'INV');

    let invoice = await Invoice.create({
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
      invoice = await postInvoice(invoice._id, req.user._id);
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
    await validateReferences({ customer, items });

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

    let result = invoice;
    if (postNow) {
      result = await postInvoice(invoice._id, req.user._id);
    }

    const populated = await Invoice.findById(result._id).populate('customer', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.post = async (req, res, next) => {
  try {
    const invoice = await postInvoice(req.params.id, req.user._id);
    res.json(invoice);
  } catch (err) {
    next(err);
  }
};

/*
  Claims the DRAFT -> POSTING transition atomically (a single findOneAndUpdate
  filtered on status: 'DRAFT') before doing any work, so two concurrent post
  requests for the same invoice can't both proceed — the loser gets a clean
  400 instead of creating a duplicate journal entry / stock movement. If
  anything fails after the claim, the invoice is reverted to DRAFT so the
  user can retry.
*/
async function postInvoice(invoiceId, userId) {
  const invoice = await Invoice.findOneAndUpdate(
    { _id: invoiceId, status: 'DRAFT' },
    { status: 'POSTING' },
    { new: true }
  );
  if (!invoice) {
    const existing = await Invoice.findById(invoiceId);
    const err = new Error(
      existing ? 'Only draft invoices can be posted.' : 'Invoice not found.'
    );
    err.statusCode = existing ? 400 : 404;
    throw err;
  }

  try {
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
        // If product.costPrice is not set, fall back to the most recent
        // incoming stock movement's unitCost so COGS can be posted.
        let unitCost = product.costPrice;
        if (!unitCost) {
          const lastIn = await StockMovement.findOne({ product: item.product, direction: 'IN', unitCost: { $gt: 0 } }).sort({ date: -1 });
          if (lastIn) unitCost = lastIn.unitCost;
        }
        const cost = round2((unitCost || 0) * item.quantity);
        totalCost += cost;
        await recordMovement({
          product: item.product,
          warehouse: item.warehouse,
          direction: 'OUT',
          quantity: item.quantity,
          unitCost,
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
  } catch (err) {
    invoice.status = 'DRAFT';
    await invoice.save().catch(() => {});
    throw err;
  }
}

exports.void = async (req, res, next) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    if (invoice.status === 'VOID') {
      return res.status(400).json({ message: 'This invoice has already been voided.' });
    }
    if (invoice.status === 'DRAFT') {
      return res.status(400).json({ message: 'Draft invoices have nothing to void — delete them instead.' });
    }
    if (invoice.amountPaid > 0) {
      return res.status(400).json({ message: 'Cannot void an invoice that has receipts allocated to it.' });
    }

    // Return the stock that was deducted when the invoice was posted.
    for (const item of invoice.items) {
      const product = await Product.findById(item.product);
      if (product && product.type === 'STOCK') {
        await recordMovement({
          product: item.product,
          warehouse: item.warehouse,
          direction: 'IN',
          quantity: item.quantity,
          unitCost: product.costPrice,
          sourceType: 'INVOICE_VOID',
          sourceId: invoice._id,
          note: `Void of invoice ${invoice.invoiceNumber}`,
          createdBy: req.user._id
        });
      }
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

    if (invoice.status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only draft invoices can be deleted. Void it instead — deleting a posted invoice would leave its ledger and stock entries orphaned.' });
    }

    await invoice.deleteOne();
    res.json({ message: 'Invoice deleted.' });
  } catch (err) {
    next(err);
  }
};
