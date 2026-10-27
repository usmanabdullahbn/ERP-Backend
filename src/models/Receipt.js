const mongoose = require('mongoose');

/*
  Money received from a customer, applied against one or more invoices.
  `discount` is a settlement discount (short payment written off) on that
  invoice: it clears the invoice balance like cash does, but is posted to
  Discount Allowed instead of the bank.
*/
const allocationSchema = new mongoose.Schema(
  {
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
    amount: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 }
  },
  { _id: false }
);

const receiptSchema = new mongoose.Schema(
  {
    receiptNumber: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    date: { type: Date, required: true, default: Date.now },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    amount: { type: Number, required: true, min: 0 },
    reference: { type: String, default: '' },
    method: { type: String, enum: ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'ONLINE', 'OTHER'], default: 'BANK_TRANSFER' },
    allocations: { type: [allocationSchema], default: [] },
    notes: { type: String, default: '' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Receipt', receiptSchema);
