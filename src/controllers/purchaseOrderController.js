const PurchaseOrder = require('../models/PurchaseOrder');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const Bill = require('../models/Bill');
const { nextNumber } = require('../services/numberSequence');
const { round2 } = require('../services/ledgerService');

function computeTotals(items) {
  let subTotal = 0;
  let taxTotal = 0;
  const withLineTotal = items.map((it) => {
    const discountRate = Number(it.discountRate ?? 0);
    const lineBase = round2(it.quantity * it.unitCost);
    const discountAmount = round2((lineBase * discountRate) / 100);
    const taxableBase = round2(lineBase - discountAmount);
    const lineTax = round2((taxableBase * (it.taxRate || 0)) / 100);
    subTotal += taxableBase;
    taxTotal += lineTax;
    return { ...it, discountRate, lineTotal: round2(taxableBase + lineTax) };
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
    const purchaseOrders = await PurchaseOrder.find(filter).populate('supplier', 'name code').sort({ date: -1 });
    res.json(purchaseOrders);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id)
      .populate('supplier')
      .populate('items.product', 'name sku unit')
      .populate('items.warehouse', 'name code')
      .populate('bill', 'billNumber status grandTotal');
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    res.json(po);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { supplier, date, dueDate, items, notes } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });
    await validateReferences({ supplier, items });

    const totals = computeTotals(items);
    const poNumber = await nextNumber('purchaseOrder', 'PO');

    const po = await PurchaseOrder.create({
      poNumber,
      supplier,
      date,
      dueDate,
      items: totals.items,
      subTotal: totals.subTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      status: 'OPEN',
      notes,
      createdBy: req.user._id
    });

    const populated = await PurchaseOrder.findById(po._id).populate('supplier', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    if (['BILLED', 'CANCELLED'].includes(po.status)) {
      return res.status(400).json({ message: 'Only open or draft purchase orders can be edited.' });
    }

    const { supplier, date, dueDate, items, notes } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });
    await validateReferences({ supplier, items });

    const totals = computeTotals(items);

    po.supplier = supplier;
    po.date = date;
    po.dueDate = dueDate;
    po.items = totals.items;
    po.subTotal = totals.subTotal;
    po.taxTotal = totals.taxTotal;
    po.grandTotal = totals.grandTotal;
    po.notes = notes;

    if (po.amountBilled >= po.grandTotal) {
      po.status = 'BILLED';
    } else {
      po.status = 'OPEN';
    }

    await po.save();
    const populated = await PurchaseOrder.findById(po._id).populate('supplier', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    if (po.bill || po.status === 'BILLED') {
      return res.status(400).json({ message: 'Cannot delete a purchase order that has been converted to a bill.' });
    }

    await PurchaseOrder.findByIdAndDelete(req.params.id);
    res.json({ message: 'Purchase order deleted.' });
  } catch (err) {
    next(err);
  }
};

exports.toBill = async (req, res, next) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id).populate('supplier');
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    if (po.bill) {
      return res.status(400).json({ message: 'This purchase order already has a bill.' });
    }

    const bill = await Bill.create({
      billNumber: await nextNumber('bill', 'BILL'),
      supplier: po.supplier._id,
      date: po.date,
      dueDate: po.dueDate,
      items: po.items.map((item) => ({
        product: item.product,
        description: item.description,
        quantity: item.quantity,
        unitCost: item.unitCost,
        taxRate: item.taxRate,
        discountRate: item.discountRate,
        warehouse: item.warehouse,
        lineTotal: item.lineTotal
      })),
      subTotal: po.subTotal,
      taxTotal: po.taxTotal,
      grandTotal: po.grandTotal,
      status: 'DRAFT',
      notes: po.notes,
      createdBy: req.user._id
    });

    po.bill = bill._id;
    po.amountBilled = po.grandTotal;
    po.status = 'BILLED';
    await po.save();

    const populated = await Bill.findById(bill._id).populate('supplier', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};
