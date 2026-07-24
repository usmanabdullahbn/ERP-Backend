const mongoose = require('mongoose');

/*
  Direct bank ledger entries not tied to a customer/supplier — e.g. bank
  transfers between accounts, bank charges, or misc income/expense.
*/
const bankTransactionSchema = new mongoose.Schema(
  {
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    date: { type: Date, required: true, default: Date.now },
    type: { type: String, enum: ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER'], required: true },
    amount: { type: Number, required: true, min: 0 },
    contraAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null }, // for deposit/withdrawal
    toBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null }, // for transfer
    reference: { type: String, default: '' },
    notes: { type: String, default: '' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BankTransaction', bankTransactionSchema);
