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

    const parseDate = (value) => {
      if (!value) return null;
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day);
    };

    const fromDate = parseDate(req.query.from);
    const toDate = parseDate(req.query.to);
    if (toDate) toDate.setHours(23, 59, 59, 999);

    const invoices = await Invoice.find({ customer: customer._id, status: { $nin: ['DRAFT', 'VOID'] } }).sort({ date: 1 });
    const receipts = await Receipt.find({ customer: customer._id }).sort({ date: 1 });

    const allEntries = [
      ...invoices.map((i) => ({ date: i.date, type: 'Invoice', ref: i.invoiceNumber, debit: i.grandTotal, credit: 0 })),
      ...receipts.map((r) => ({ date: r.date, type: 'Receipt', ref: r.receiptNumber, debit: 0, credit: r.amount }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let openingBalance = customer.openingBalance || 0;
    let entries = allEntries;

    if (fromDate) {
      const beforeFrom = entries.filter((e) => new Date(e.date) < fromDate);
      openingBalance += beforeFrom.reduce((sum, e) => sum + e.debit - e.credit, 0);
      entries = entries.filter((e) => new Date(e.date) >= fromDate);
    }

    if (toDate) {
      entries = entries.filter((e) => new Date(e.date) <= toDate);
    }

    let balance = openingBalance;
    const withBalance = entries.map((e) => {
      balance += e.debit - e.credit;
      return { ...e, balance };
    });

    res.json({
      customer,
      openingBalance,
      entries: withBalance,
      closingBalance: balance,
      from: req.query.from || null,
      to: req.query.to || null
    });
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    let { code, name, email, phone, address, taxNumber, discountRate, openingBalance, creditLimit } = req.body;
    if (!code) code = await nextNumber('customer', 'CUST', 4);
    const customer = await Customer.create({ code, name, email, phone, address, taxNumber, discountRate, openingBalance, creditLimit });
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
