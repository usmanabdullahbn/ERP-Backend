const mongoose = require('mongoose');

/*
  Core of the double-entry ledger. Every financial transaction in the system
  (invoice, bill, receipt, payment, bank transfer, manual journal) creates one
  of these. Total debits must equal total credits — enforced in ledgerService.
*/
const journalLineSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    memo: { type: String, default: '' }
  },
  { _id: false }
);

const journalEntrySchema = new mongoose.Schema(
  {
    entryNumber: { type: String, required: true, unique: true },
    date: { type: Date, required: true, default: Date.now },
    sourceType: {
      type: String,
      enum: ['INVOICE', 'RECEIPT', 'BILL', 'PAYMENT', 'BANK_TRANSFER', 'MANUAL', 'OPENING_BALANCE'],
      required: true
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reference: { type: String, default: '' },
    narration: { type: String, default: '' },
    lines: {
      type: [journalLineSchema],
      validate: {
        validator: (lines) => Array.isArray(lines) && lines.length >= 2,
        message: 'A journal entry needs at least two lines (double entry).'
      }
    },
    totalDebit: { type: Number, required: true },
    totalCredit: { type: Number, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    isReversed: { type: Boolean, default: false },
    reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null }
  },
  { timestamps: true }
);

journalEntrySchema.index({ date: 1 });
journalEntrySchema.index({ sourceType: 1, sourceId: 1 });

module.exports = mongoose.model('JournalEntry', journalEntrySchema);
