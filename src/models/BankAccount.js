const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    accountNumber: { type: String, default: '' },
    bankName: { type: String, default: '' },
    type: { type: String, enum: ['BANK', 'CASH'], default: 'BANK' },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true }, // linked GL account
    openingBalance: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BankAccount', bankAccountSchema);
