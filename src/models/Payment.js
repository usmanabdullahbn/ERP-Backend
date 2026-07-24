const mongoose = require('mongoose');

/* Money paid to a supplier, applied against one or more bills. */
const allocationSchema = new mongoose.Schema(
  {
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', required: true },
    amount: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    paymentNumber: { type: String, required: true, unique: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    date: { type: Date, required: true, default: Date.now },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER'], default: 'BANK_TRANSFER' },
    allocations: { type: [allocationSchema], default: [] },
    notes: { type: String, default: '' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payment', paymentSchema);
