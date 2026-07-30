const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const BankAccount = require('../models/BankAccount');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { getAccountByCode } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');

exports.list = async (req, res, next) => {
  try {
    const payments = await Payment.find().populate('supplier', 'name code').populate('bankAccount', 'name').sort({ date: -1 });
    res.json(payments);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id)
      .populate('supplier')
      .populate('bankAccount')
      .populate('allocations.bill', 'billNumber grandTotal amountPaid');
    if (!payment) return res.status(404).json({ message: 'Payment not found.' });
    res.json(payment);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { supplier, date, bankAccount, amount, method, allocations, notes } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than zero.' });

    const allocatedTotal = round2((allocations || []).reduce((s, a) => s + a.amount, 0));
    if (allocatedTotal > round2(amount)) {
      return res.status(400).json({ message: 'Allocated amount cannot exceed the payment amount.' });
    }

    const bank = await BankAccount.findById(bankAccount);
    if (!bank) return res.status(400).json({ message: 'Bank account not found.' });

    const ap = await getAccountByCode(SYS.ACCOUNTS_PAYABLE);
    const paymentNumber = await nextNumber('payment', 'PMT');

    const lines = [
      { account: ap._id, debit: amount, credit: 0, memo: `Payment ${paymentNumber}` },
      { account: bank.account, debit: 0, credit: amount, memo: `Payment ${paymentNumber}` }
    ];

    const entry = await postJournal({
      date: date || new Date(),
      sourceType: 'PAYMENT',
      reference: paymentNumber,
      narration: `Payment to supplier`,
      lines,
      createdBy: req.user._id
    });

    const payment = await Payment.create({
      paymentNumber,
      supplier,
      date,
      bankAccount,
      amount,
      method,
      allocations,
      notes,
      journalEntry: entry._id,
      createdBy: req.user._id
    });
    entry.sourceId = payment._id;
    await entry.save();

    for (const alloc of allocations || []) {
      const bill = await Bill.findById(alloc.bill);
      if (!bill) continue;
      bill.amountPaid = round2(bill.amountPaid + alloc.amount);
      bill.status = bill.amountPaid >= bill.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await bill.save();
    }

    const populated = await Payment.findById(payment._id).populate('supplier', 'name code').populate('bankAccount', 'name');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found.' });

    const { supplier, date, bankAccount, amount, method, allocations, notes } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than zero.' });

    const allocatedTotal = round2((allocations || []).reduce((s, a) => s + a.amount, 0));
    if (allocatedTotal > round2(amount)) {
      return res.status(400).json({ message: 'Allocated amount cannot exceed the payment amount.' });
    }

    const bank = await BankAccount.findById(bankAccount);
    if (!bank) return res.status(400).json({ message: 'Bank account not found.' });

    const ap = await getAccountByCode(SYS.ACCOUNTS_PAYABLE);

    for (const alloc of payment.allocations || []) {
      const bill = await Bill.findById(alloc.bill);
      if (!bill) continue;
      bill.amountPaid = round2(Math.max(0, bill.amountPaid - alloc.amount));
      bill.status = bill.amountPaid === 0 ? 'POSTED' : bill.amountPaid >= bill.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await bill.save();
    }

    if (payment.journalEntry) {
      await reverseJournal(payment.journalEntry, { createdBy: req.user._id });
    }

    const lines = [
      { account: ap._id, debit: amount, credit: 0, memo: `Payment ${payment.paymentNumber}` },
      { account: bank.account, debit: 0, credit: amount, memo: `Payment ${payment.paymentNumber}` }
    ];

    const entry = await postJournal({
      date: date || new Date(),
      sourceType: 'PAYMENT',
      reference: payment.paymentNumber,
      narration: `Payment to supplier`,
      lines,
      createdBy: req.user._id
    });

    const updatedPayment = await Payment.findByIdAndUpdate(
      req.params.id,
      {
        supplier,
        date,
        bankAccount,
        amount,
        method,
        allocations: allocations || [],
        notes,
        journalEntry: entry._id,
        createdBy: payment.createdBy || req.user._id
      },
      { new: true }
    );

    entry.sourceId = updatedPayment._id;
    await entry.save();

    for (const alloc of allocations || []) {
      const bill = await Bill.findById(alloc.bill);
      if (!bill) continue;
      bill.amountPaid = round2(bill.amountPaid + alloc.amount);
      bill.status = bill.amountPaid >= bill.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await bill.save();
    }

    const populated = await Payment.findById(updatedPayment._id).populate('supplier', 'name code').populate('bankAccount', 'name');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found.' });

    for (const alloc of payment.allocations || []) {
      const bill = await Bill.findById(alloc.bill);
      if (!bill) continue;
      bill.amountPaid = round2(Math.max(0, bill.amountPaid - alloc.amount));
      bill.status = bill.amountPaid === 0 ? 'POSTED' : bill.amountPaid >= bill.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await bill.save();
    }

    if (payment.journalEntry) {
      await reverseJournal(payment.journalEntry, { createdBy: req.user._id });
    }
    await payment.deleteOne();
    res.json({ message: 'Payment deleted and reversed.' });
  } catch (err) {
    next(err);
  }
};
