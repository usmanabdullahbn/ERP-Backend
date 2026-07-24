const Supplier = require('../models/Supplier');
const Bill = require('../models/Bill');
const Payment = require('../models/Payment');
const { nextNumber } = require('../services/numberSequence');

exports.list = async (req, res, next) => {
  try {
    const suppliers = await Supplier.find().sort({ name: 1 });
    res.json(suppliers);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ message: 'Supplier not found.' });
    res.json(supplier);
  } catch (err) {
    next(err);
  }
};

exports.statement = async (req, res, next) => {
  try {
    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) return res.status(404).json({ message: 'Supplier not found.' });

    const bills = await Bill.find({ supplier: supplier._id, status: { $ne: 'DRAFT' } }).sort({ date: 1 });
    const payments = await Payment.find({ supplier: supplier._id }).sort({ date: 1 });

    const entries = [
      ...bills.map((b) => ({ date: b.date, type: 'Bill', ref: b.billNumber, debit: 0, credit: b.grandTotal })),
      ...payments.map((p) => ({ date: p.date, type: 'Payment', ref: p.paymentNumber, debit: p.amount, credit: 0 }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    let balance = supplier.openingBalance || 0;
    const withBalance = entries.map((e) => {
      balance += e.credit - e.debit;
      return { ...e, balance };
    });

    res.json({ supplier, openingBalance: supplier.openingBalance || 0, entries: withBalance, closingBalance: balance });
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    let { code, name, email, phone, address, taxNumber, openingBalance } = req.body;
    if (!code) code = await nextNumber('supplier', 'SUPP', 4);
    const supplier = await Supplier.create({ code, name, email, phone, address, taxNumber, openingBalance });
    res.status(201).json(supplier);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!supplier) return res.status(404).json({ message: 'Supplier not found.' });
    res.json(supplier);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const hasBills = await Bill.exists({ supplier: req.params.id });
    if (hasBills) {
      return res.status(400).json({ message: 'Cannot delete a supplier with existing bills. Deactivate instead.' });
    }
    const supplier = await Supplier.findByIdAndDelete(req.params.id);
    if (!supplier) return res.status(404).json({ message: 'Supplier not found.' });
    res.json({ message: 'Supplier deleted.' });
  } catch (err) {
    next(err);
  }
};
