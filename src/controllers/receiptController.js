const Receipt = require('../models/Receipt');
const Invoice = require('../models/Invoice');
const Customer = require('../models/Customer');
const BankAccount = require('../models/BankAccount');
const { nextNumber } = require('../services/numberSequence');
const { postJournal, reverseJournal, round2 } = require('../services/ledgerService');
const { getAccountByCode, getOrCreateSystemAccount } = require('../utils/getAccount');
const SYS = require('../utils/systemAccounts');
const { withTransaction, httpError } = require('../services/transaction');

// How much of an invoice's balance an allocation clears: cash plus discount.
const settledBy = (alloc) => round2(Number(alloc.amount || 0) + Number(alloc.discount || 0));

/* Cleans the posted allocations: numbers only, and drops rows with nothing applied. */
function normalizeAllocations(allocations) {
  return (allocations || [])
    .map((a) => ({ invoice: a.invoice, amount: round2(Number(a.amount) || 0), discount: round2(Number(a.discount) || 0) }))
    .filter((a) => a.amount > 0 || a.discount > 0);
}

/*
  Journal for a receipt: the bank gets the cash, Discount Allowed gets any
  settlement discount, and AR is cleared by both together.
*/
async function receiptJournalLines({ bank, amount, allocations, receiptNumber }) {
  const ar = await getAccountByCode(SYS.ACCOUNTS_RECEIVABLE);
  const discount = round2(allocations.reduce((s, a) => s + a.discount, 0));
  const lines = [
    { account: bank.account, debit: amount, credit: 0, memo: `Receipt ${receiptNumber}` }
  ];
  if (discount > 0) {
    const discountAllowed = await getOrCreateSystemAccount(SYS.DISCOUNT_ALLOWED, {
      name: 'Discount Allowed',
      namePattern: /discount/i,
      type: 'EXPENSE',
      subType: 'Operating Expense',
      normalBalance: 'debit'
    });
    lines.push({ account: discountAllowed._id, debit: discount, credit: 0, memo: `Discount on receipt ${receiptNumber}` });
  }
  lines.push({ account: ar._id, debit: 0, credit: round2(amount + discount), memo: `Receipt ${receiptNumber}` });
  return lines;
}

async function applyToInvoices(allocations, sign) {
  for (const alloc of allocations || []) {
    const invoice = await Invoice.findById(alloc.invoice);
    if (!invoice) continue;
    invoice.amountPaid = round2(Math.max(0, invoice.amountPaid + sign * settledBy(alloc)));
    invoice.status = invoice.amountPaid === 0 ? 'POSTED' : invoice.amountPaid >= invoice.grandTotal ? 'PAID' : 'PARTIALLY_PAID';
    await invoice.save();
  }
}

/*
  Checks every allocation against the actual invoice before anything is
  written: the invoice must exist, must be POSTED/PARTIALLY_PAID (not a
  DRAFT with no journal entry, not a VOID that's already reversed), and the
  amount plus discount can't exceed what's still owed on it. Returns nothing —
  throws a 400 on the first problem found, so the caller can validate before
  creating the journal entry / receipt document.
*/
async function assertAllocationsValid(allocations) {
  for (const alloc of allocations || []) {
    const invoice = await Invoice.findById(alloc.invoice);
    if (!invoice) {
      const err = new Error('One or more allocations reference an invoice that does not exist.');
      err.statusCode = 400;
      throw err;
    }
    if (!['POSTED', 'PARTIALLY_PAID'].includes(invoice.status)) {
      const err = new Error(`Cannot allocate to invoice ${invoice.invoiceNumber} — it is ${invoice.status.toLowerCase().replace('_', ' ')}, not posted.`);
      err.statusCode = 400;
      throw err;
    }
    const remaining = round2(invoice.grandTotal - invoice.amountPaid);
    if (settledBy(alloc) > remaining) {
      const err = new Error(`Amount plus discount of ${settledBy(alloc)} on invoice ${invoice.invoiceNumber} exceeds its remaining balance of ${remaining}.`);
      err.statusCode = 400;
      throw err;
    }
  }
}

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
    if (!receipt) throw httpError(404, 'Receipt not found.');
    res.json(receipt);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const receipt = await withTransaction(async () => {
      const { customer, date, bankAccount, amount, reference, method, notes } = req.body;
      const allocations = normalizeAllocations(req.body.allocations);
      if (!amount || amount <= 0) throw httpError(400, 'Amount must be greater than zero.');

      const customerDoc = await Customer.findById(customer);
      if (!customerDoc) throw httpError(400, 'Selected customer does not exist.');

      const allocatedTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));
      if (allocatedTotal > round2(amount)) {
        throw httpError(400, 'Allocated amount cannot exceed the receipt amount.');
      }
      await assertAllocationsValid(allocations);

      const bank = await BankAccount.findById(bankAccount);
      if (!bank) throw httpError(400, 'Bank account not found.');

      const receiptNumber = await nextNumber('receipt', 'RCPT');
      const lines = await receiptJournalLines({ bank, amount, allocations, receiptNumber });

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
        reference: reference || receiptNumber,
        method,
        allocations,
        notes,
        journalEntry: entry._id,
        createdBy: req.user._id
      });
      entry.sourceId = receipt._id;
      await entry.save();

      await applyToInvoices(allocations, 1);

      return receipt;
    });

    const populated = await Receipt.findById(receipt._id).populate('customer', 'name code').populate('bankAccount', 'name');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const updatedReceipt = await withTransaction(async () => {
      const receipt = await Receipt.findById(req.params.id);
      if (!receipt) throw httpError(404, 'Receipt not found.');

      const { customer, date, bankAccount, amount, reference, method, notes } = req.body;
      const allocations = normalizeAllocations(req.body.allocations);
      if (!amount || amount <= 0) throw httpError(400, 'Amount must be greater than zero.');

      const customerDoc = await Customer.findById(customer);
      if (!customerDoc) throw httpError(400, 'Selected customer does not exist.');

      const allocatedTotal = round2(allocations.reduce((s, a) => s + a.amount, 0));
      if (allocatedTotal > round2(amount)) {
        throw httpError(400, 'Allocated amount cannot exceed the receipt amount.');
      }

      const bank = await BankAccount.findById(bankAccount);
      if (!bank) throw httpError(400, 'Bank account not found.');

      // Reverse the old allocations first so the new allocations are validated
      // against each invoice's true remaining balance.
      await applyToInvoices(receipt.allocations, -1);

      let lines;
      try {
        await assertAllocationsValid(allocations);
        lines = await receiptJournalLines({ bank, amount, allocations, receiptNumber: receipt.receiptNumber });
      } catch (validationErr) {
        // Re-apply the old allocations we just reversed so we don't leave the
        // invoices in a partially-reversed state if the new ones are rejected.
        await applyToInvoices(receipt.allocations, 1);
        throw validationErr;
      }

      if (receipt.journalEntry) {
        await reverseJournal(receipt.journalEntry, { createdBy: req.user._id });
      }

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
          reference: reference || receipt.receiptNumber,
          method,
          allocations,
          notes,
          journalEntry: entry._id,
          createdBy: receipt.createdBy || req.user._id
        },
        { new: true }
      );

      entry.sourceId = updatedReceipt._id;
      await entry.save();

      await applyToInvoices(allocations, 1);

      return updatedReceipt;
    });

    const populated = await Receipt.findById(updatedReceipt._id).populate('customer', 'name code').populate('bankAccount', 'name');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const receipt = await Receipt.findById(req.params.id);
      if (!receipt) throw httpError(404, 'Receipt not found.');

      await applyToInvoices(receipt.allocations, -1);

      if (receipt.journalEntry) {
        await reverseJournal(receipt.journalEntry, { createdBy: req.user._id });
      }
      await receipt.deleteOne();
    });
    res.json({ message: 'Receipt deleted and reversed.' });
  } catch (err) {
    next(err);
  }
};
