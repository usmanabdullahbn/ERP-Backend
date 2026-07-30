const Receipt = require('../models/Receipt');
const Invoice = require('../models/Invoice');
const BankAccount = require('../models/BankAccount');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { getAccountByCode } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');

exports.list = async (req, res, next) => {
  try {
    const receipts = await Receipt.find().populate('customer', 'name code').populate('bankAccount', 'name').sort({ date: -1 });
    res.json(receipts);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const receipt = await Receipt.findById(req.params.id)
      .populate('customer')
      .populate('bankAccount')
      .populate('allocations.invoice', 'invoiceNumber grandTotal amountPaid');
    if (!receipt) return res.status(404).json({ message: 'Receipt not found.' });
    res.json(receipt);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { customer, date, bankAccount, amount, method, allocations, notes } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than zero.' });

    const allocatedTotal = round2((allocations || []).reduce((s, a) => s + a.amount, 0));
    if (allocatedTotal > round2(amount)) {
      return res.status(400).json({ message: 'Allocated amount cannot exceed the receipt amount.' });
    }

    const bank = await BankAccount.findById(bankAccount);
    if (!bank) return res.status(400).json({ message: 'Bank account not found.' });

    const ar = await getAccountByCode(SYS.ACCOUNTS_RECEIVABLE);

    const receiptNumber = await nextNumber('receipt', 'RCPT');

    const lines = [
      { account: bank.account, debit: amount, credit: 0, memo: `Receipt ${receiptNumber}` },
      { account: ar._id, debit: 0, credit: amount, memo: `Receipt ${receiptNumber}` }
    ];

    const entry = await postJournal({
      date: date || new Date(),
      sourceType: 'RECEIPT',
      reference: receiptNumber,
      narration: `Receipt from customer`,
      lines,
      createdBy: req.user._id
    });

    const receipt = await Receipt.create({
      receiptNumber,
      customer,
      date,
      bankAccount,
      amount,
      method,
      allocations,
      notes,
      journalEntry: entry._id,
      createdBy: req.user._id
    });
    entry.sourceId = receipt._id;
    await entry.save();

    for (const alloc of allocations || []) {
      const invoice = await Invoice.findById(alloc.invoice);
      if (!invoice) continue;
      invoice.amountPaid = round2(invoice.amountPaid + alloc.amount);
      invoice.status = invoice.amountPaid >= invoice.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await invoice.save();
    }

    const populated = await Receipt.findById(receipt._id).populate('customer', 'name code').populate('bankAccount', 'name');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: 'Receipt not found.' });

    const { customer, date, bankAccount, amount, method, allocations, notes } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount must be greater than zero.' });

    const allocatedTotal = round2((allocations || []).reduce((s, a) => s + a.amount, 0));
    if (allocatedTotal > round2(amount)) {
      return res.status(400).json({ message: 'Allocated amount cannot exceed the receipt amount.' });
    }

    const bank = await BankAccount.findById(bankAccount);
    if (!bank) return res.status(400).json({ message: 'Bank account not found.' });

    const ar = await getAccountByCode(SYS.ACCOUNTS_RECEIVABLE);

    for (const alloc of receipt.allocations || []) {
      const invoice = await Invoice.findById(alloc.invoice);
      if (!invoice) continue;
      invoice.amountPaid = round2(Math.max(0, invoice.amountPaid - alloc.amount));
      invoice.status = invoice.amountPaid === 0 ? 'POSTED' : invoice.amountPaid >= invoice.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await invoice.save();
    }

    if (receipt.journalEntry) {
      await reverseJournal(receipt.journalEntry, { createdBy: req.user._id });
    }

    const lines = [
      { account: bank.account, debit: amount, credit: 0, memo: `Receipt ${receipt.receiptNumber}` },
      { account: ar._id, debit: 0, credit: amount, memo: `Receipt ${receipt.receiptNumber}` }
    ];

    const entry = await postJournal({
      date: date || new Date(),
      sourceType: 'RECEIPT',
      reference: receipt.receiptNumber,
      narration: `Receipt from customer`,
      lines,
      createdBy: req.user._id
    });

    const updatedReceipt = await Receipt.findByIdAndUpdate(
      req.params.id,
      {
        customer,
        date,
        bankAccount,
        amount,
        method,
        allocations: allocations || [],
        notes,
        journalEntry: entry._id,
        createdBy: receipt.createdBy || req.user._id
      },
      { new: true }
    );

    entry.sourceId = updatedReceipt._id;
    await entry.save();

    for (const alloc of allocations || []) {
      const invoice = await Invoice.findById(alloc.invoice);
      if (!invoice) continue;
      invoice.amountPaid = round2(invoice.amountPaid + alloc.amount);
      invoice.status = invoice.amountPaid >= invoice.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await invoice.save();
    }

    const populated = await Receipt.findById(updatedReceipt._id).populate('customer', 'name code').populate('bankAccount', 'name');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const receipt = await Receipt.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: 'Receipt not found.' });

    // Reverse invoice allocations
    for (const alloc of receipt.allocations || []) {
      const invoice = await Invoice.findById(alloc.invoice);
      if (!invoice) continue;
      invoice.amountPaid = round2(Math.max(0, invoice.amountPaid - alloc.amount));
      invoice.status = invoice.amountPaid === 0 ? 'POSTED' : invoice.amountPaid >= invoice.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
      await invoice.save();
    }

    if (receipt.journalEntry) {
      await reverseJournal(receipt.journalEntry, { createdBy: req.user._id });
    }
    await receipt.deleteOne();
    res.json({ message: 'Receipt deleted and reversed.' });
  } catch (err) {
    next(err);
  }
};
