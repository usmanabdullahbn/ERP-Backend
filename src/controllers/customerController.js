const Customer = require('../models/Customer');
const Invoice = require('../models/Invoice');
const Receipt = require('../models/Receipt');
const { nextNumber } = require('../services/numberSequence');

exports.list = async (req, res, next) => {
  try {
    const customers = await Customer.find().sort({ name: 1 });
    res.json(customers);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found.' });
    res.json(customer);
  } catch (err) {
    next(err);
  }
};

/* Customer statement: all invoices + receipts, running balance. */
exports.statement = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found.' });

    const invoices = await Invoice.find({ customer: customer._id, status: { $ne: 'DRAFT' } }).sort({ date: 1 });
    const receipts = await Receipt.find({ customer: customer._id }).sort({ date: 1 });

    const entries = [
      ...invoices.map((i) => ({ date: i.date, type: 'Invoice', ref: i.invoiceNumber, debit: i.grandTotal, credit: 0 })),
      ...receipts.map((r) => ({ date: r.date, type: 'Receipt', ref: r.receiptNumber, debit: 0, credit: r.amount }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let balance = customer.openingBalance || 0;
    const withBalance = entries.map((e) => {
      balance += e.debit - e.credit;
      return { ...e, balance };
    });

    res.json({ customer, openingBalance: customer.openingBalance || 0, entries: withBalance, closingBalance: balance });
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    let { code, name, email, phone, address, taxNumber, openingBalance, creditLimit } = req.body;
    if (!code) code = await nextNumber('customer', 'CUST', 4);
    const customer = await Customer.create({ code, name, email, phone, address, taxNumber, openingBalance, creditLimit });
    res.status(201).json(customer);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!customer) return res.status(404).json({ message: 'Customer not found.' });
    res.json(customer);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const hasInvoices = await Invoice.exists({ customer: req.params.id });
    if (hasInvoices) {
      return res.status(400).json({ message: 'Cannot delete a customer with existing invoices. Deactivate instead.' });
    }
    const customer = await Customer.findByIdAndDelete(req.params.id);
    if (!customer) return res.status(404).json({ message: 'Customer not found.' });
    res.json({ message: 'Customer deleted.' });
  } catch (err) {
    next(err);
  }
};
