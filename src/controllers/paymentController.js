const Payment = require('../models/Payment');
const Bill = require('../models/Bill');
const Supplier = require('../models/Supplier');
const BankAccount = require('../models/BankAccount');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { getAccountByCode, getOrCreateSystemAccount } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');
const { withTransaction, httpError } = require('../services/transaction');

// How much of a bill's balance an allocation clears: cash plus discount.
const settledBy = (alloc) => round2(Number(alloc.amount || 0) + Number(alloc.discount || 0));

/* Cleans the posted allocations: numbers only, and drops rows with nothing applied. */
function normalizeAllocations(allocations) {
  return (allocations || [])
    .map((a) => ({ bill: a.bill, amount: round2(Number(a.amount) || 0), discount: round2(Number(a.discount) || 0) }))
    .filter((a) => a.amount > 0 || a.discount > 0);
}

/*
  Journal for a payment: AP is cleared by cash plus any settlement discount;
  the bank pays the cash and Discount Received takes the discount.
*/
async function paymentJournalLines({ bank, amount, allocations, paymentNumber }) {
  const ap = await getAccountByCode(SYS.ACCOUNTS_PAYABLE);
  const discount = round2(allocations.reduce((s, a) => s + a.discount, 0));
  const lines = [
    { account: ap._id, debit: round2(amount + discount), credit: 0, memo: `Payment ${paymentNumber}` },
    { account: bank.account, debit: 0, credit: amount, memo: `Payment ${paymentNumber}` }
  ];
  if (discount > 0) {
    const discountReceived = await getOrCreateSystemAccount(SYS.DISCOUNT_RECEIVED, {
      name: 'Discount Received',
      namePattern: /discount/i,
      type: 'INCOME',
      subType: 'Other Income',
      normalBalance: 'credit'
    });
    lines.push({ account: discountReceived._id, debit: 0, credit: discount, memo: `Discount on payment ${paymentNumber}` });
  }
  return lines;
}

async function applyToBills(allocations, sign) {
  for (const alloc of allocations || []) {
    const bill = await Bill.findById(alloc.bill);
    if (!bill) continue;
    bill.amountPaid = round2(Math.max(0, bill.amountPaid + sign * settledBy(alloc)));
    bill.status = bill.amountPaid === 0 ? 'POSTED' : bill.amountPaid >= bill.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
    await bill.save();
  }
}

/* See receiptController.assertAllocationsValid for why this runs before anything is written. */
async function assertAllocationsValid(allocations) {
  for (const alloc of allocations || []) {
    const bill = await Bill.findById(alloc.bill);
    if (!bill) {
      const err = new Error('One or more allocations reference a bill that does not exist.');
      err.statusCode = 400;
      throw err;
    }
    if (!['POSTED', 'PARTIALLY_PAID'].includes(bill.status)) {
      const err = new Error(`Cannot allocate to bill ${bill.billNumber} — it is ${bill.status.toLowerCase().replace('_', ' ')}, not posted.`);
      err.statusCode = 400;
      throw err;
    }
    const remaining = round2(bill.grandTotal - bill.amountPaid);
    if (settledBy(alloc) > remaining) {
      const err = new Error(`Amount plus discount of ${settledBy(alloc)} on bill ${bill.billNumber} exceeds its remaining balance of ${remaining}.`);
      err.statusCode = 400;
      throw err;
    }
  }
}

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
    if (!payment) throw httpError(404, 'Payment not found.');
    res.json(payment);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const payment = await withTransaction(async () => {
      const { supplier, date, bankAccount, amount, reference, method, notes } = req.body;
      const allocations = normalizeAllocations(req.body.allocations);
      if (!amount || amount <= 0) throw httpError(400, 'Amount must be greater than zero.');

      const supplierDoc = await Supplier.findById(supplier);
      if (!supplierDoc) throw httpError(400, 'Selected supplier does not exist.');

      const allocatedTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));
      if (allocatedTotal > round2(amount)) {
        throw httpError(400, 'Allocated amount cannot exceed the payment amount.');
      }
      await assertAllocationsValid(allocations);

      const bank = await BankAccount.findById(bankAccount);
      if (!bank) throw httpError(400, 'Bank account not found.');

      const paymentNumber = await nextNumber('payment', 'PMT');
      const lines = await paymentJournalLines({ bank, amount, allocations, paymentNumber });

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
        reference: reference || paymentNumber,
        method,
        allocations,
        notes,
        journalEntry: entry._id,
        createdBy: req.user._id
      });
      entry.sourceId = payment._id;
      await entry.save();

      await applyToBills(allocations, 1);

      return payment;
    });

    const populated = await Payment.findById(payment._id).populate('supplier', 'name code').populate('bankAccount', 'name');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const updatedPayment = await withTransaction(async () => {
      const payment = await Payment.findById(req.params.id);
      if (!payment) throw httpError(404, 'Payment not found.');

      const { supplier, date, bankAccount, amount, reference, method, notes } = req.body;
      const allocations = normalizeAllocations(req.body.allocations);
      if (!amount || amount <= 0) throw httpError(400, 'Amount must be greater than zero.');

      const supplierDoc = await Supplier.findById(supplier);
      if (!supplierDoc) throw httpError(400, 'Selected supplier does not exist.');

      const allocatedTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));
      if (allocatedTotal > round2(amount)) {
        throw httpError(400, 'Allocated amount cannot exceed the payment amount.');
      }

      const bank = await BankAccount.findById(bankAccount);
      if (!bank) throw httpError(400, 'Bank account not found.');

      // Reverse the old allocations first so the new allocations are validated
      // against each bill's true remaining balance.
      await applyToBills(payment.allocations, -1);

      let lines;
      try {
        await assertAllocationsValid(allocations);
        lines = await paymentJournalLines({ bank, amount, allocations, paymentNumber: payment.paymentNumber });
      } catch (validationErr) {
        await applyToBills(payment.allocations, 1);
        throw validationErr;
      }

      if (payment.journalEntry) {
        await reverseJournal(payment.journalEntry, { createdBy: req.user._id });
      }

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
          reference: reference || payment.paymentNumber,
          method,
          allocations,
          notes,
          journalEntry: entry._id,
          createdBy: payment.createdBy || req.user._id
        },
        { new: true }
      );

      entry.sourceId = updatedPayment._id;
      await entry.save();

      await applyToBills(allocations, 1);

      return updatedPayment;
    });

    const populated = await Payment.findById(updatedPayment._id).populate('supplier', 'name code').populate('bankAccount', 'name');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const payment = await Payment.findById(req.params.id);
      if (!payment) throw httpError(404, 'Payment not found.');

      await applyToBills(payment.allocations, -1);

      if (payment.journalEntry) {
        await reverseJournal(payment.journalEntry, { createdBy: req.user._id });
      }
      await payment.deleteOne();
    });
    res.json({ message: 'Payment deleted and reversed.' });
  } catch (err) {
    next(err);
  }
};
