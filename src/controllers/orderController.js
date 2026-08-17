const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const Warehouse = require('../models/Warehouse');
const Invoice = require('../models/Invoice');
const { nextNumber } = require('../services/numberSequence');
const { round2 } = require('../services/ledgerService');

function computeTotals(items) {
  let subTotal = 0;
  let taxTotal = 0;
  const withLineTotal = items.map((it) => {
    const discountRate = Number(it.discountRate ?? 0);
    const lineBase = round2(it.quantity * it.unitPrice);
    const discountAmount = round2((lineBase * discountRate) / 100);
    const taxableBase = round2(lineBase - discountAmount);
    const lineTax = round2((taxableBase * (it.taxRate || 0)) / 100);
    subTotal += taxableBase;
    taxTotal += lineTax;
    return { ...it, discountRate, lineTotal: round2(taxableBase + lineTax) };
  });
  return { items: withLineTotal, subTotal: round2(subTotal), taxTotal: round2(taxTotal), grandTotal: round2(subTotal + taxTotal) };
}

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

  const defaultDiscount = Number(customerDoc.discountRate || 0);
  const normalizedItems = items.map((it) => ({
    ...it,
    discountRate: it.discountRate === undefined || it.discountRate === null ? defaultDiscount : Number(it.discountRate)
  }));

  return { customerDoc, items: normalizedItems };
}

exports.list = async (req, res, next) => {
  try {
    const { status, customer } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (customer) filter.customer = customer;
    const orders = await Order.find(filter).populate('customer', 'name code').sort({ date: -1 });
    res.json(orders);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customer')
      .populate('items.product', 'name sku unit')
      .populate('items.warehouse', 'name code')
      .populate('invoice', 'invoiceNumber status grandTotal');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    res.json(order);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { customer, date, dueDate, items, notes } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });
    const { items: normalizedItems } = await validateReferences({ customer, items });

    const totals = computeTotals(normalizedItems);
    const orderNumber = await nextNumber('salesOrder', 'SO');

    const order = await Order.create({
      orderNumber,
      customer,
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

    const populated = await Order.findById(order._id).populate('customer', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (['INVOICED', 'CANCELLED'].includes(order.status)) {
      return res.status(400).json({ message: 'Only open or draft orders can be edited.' });
    }

    const { customer, date, dueDate, items, notes } = req.body;
    if (!items || !items.length) return res.status(400).json({ message: 'At least one line item is required.' });
    const { items: normalizedItems } = await validateReferences({ customer, items });

    const totals = computeTotals(normalizedItems);

    order.customer = customer;
    order.date = date;
    order.dueDate = dueDate;
    order.items = totals.items;
    order.subTotal = totals.subTotal;
    order.taxTotal = totals.taxTotal;
    order.grandTotal = totals.grandTotal;
    order.notes = notes;

    if (order.amountInvoiced >= order.grandTotal) {
      order.status = 'INVOICED';
    } else {
      order.status = 'OPEN';
    }

    await order.save();
    const populated = await Order.findById(order._id).populate('customer', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (order.invoice || order.status === 'INVOICED') {
      return res.status(400).json({ message: 'Cannot delete an order that has been converted to an invoice.' });
    }

    await Order.findByIdAndDelete(req.params.id);
    res.json({ message: 'Order deleted.' });
  } catch (err) {
    next(err);
  }
};

exports.toInvoice = async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).populate('customer');
    if (!order) return res.status(404).json({ message: 'Order not found.' });
    if (order.invoice) {
      return res.status(400).json({ message: 'This order already has an invoice.' });
    }

    const invoice = await Invoice.create({
      invoiceNumber: await nextNumber('invoice', 'INV'),
      customer: order.customer._id,
      date: order.date,
      dueDate: order.dueDate,
      items: order.items.map((item) => ({
        product: item.product,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        taxRate: item.taxRate,
        discountRate: item.discountRate,
        warehouse: item.warehouse,
        lineTotal: item.lineTotal
      })),
      subTotal: order.subTotal,
      taxTotal: order.taxTotal,
      grandTotal: order.grandTotal,
      status: 'DRAFT',
      notes: order.notes,
      createdBy: req.user._id
    });

    order.invoice = invoice._id;
    order.amountInvoiced = order.grandTotal;
    order.status = 'INVOICED';
    await order.save();

    const populated = await Invoice.findById(invoice._id).populate('customer', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};
