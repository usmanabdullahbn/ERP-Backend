const mongoose = require('mongoose');

/*
  Chart of Accounts.
  type drives which financial statement the account rolls into:
  ASSET, LIABILITY, EQUITY, INCOME, EXPENSE
  normalBalance: 'debit' or 'credit' — used to compute running balances consistently.
*/
const accountSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'],
      required: true
    },
    subType: { type: String, default: '' }, // e.g. 'Current Asset', 'Bank', 'Accounts Receivable'
    normalBalance: { type: String, enum: ['debit', 'credit'], required: true },
    isSystem: { type: Boolean, default: false }, // protects core control accounts (AR, AP, Inventory, etc)
    isActive: { type: Boolean, default: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    description: { type: String, default: '' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Account', accountSchema);
