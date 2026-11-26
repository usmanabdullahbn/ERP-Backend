const mongoose = require('mongoose');

const projectExpenseSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    label: { type: String, default: '' },
    amount: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const projectMaalAllocationSchema = new mongoose.Schema(
  {
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true },
    invoiceAmount: { type: Number, default: 0 },
    settledAmount: { type: Number, default: 0 }
  },
  { _id: false }
);

const projectPaymentLogSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['CLIENT_RECEIPT', 'FABRICATOR_PAYMENT'], required: true },
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    reference: { type: String, default: '' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null }
  },
  { _id: true }
);

/*
  Tracks a Fabrication / Project Deal (both IN_HOUSE like Imran and OUTSOURCE
  like Najam Masjid / Rashid Butt) separately from Maal (trading) invoices so:
  - Maal Sales Revenue (4000) stays distinct from Project Extra Revenue & Commission (4500)
  - Linked Maal Invoice can belong either to the Client (In-House) or the Fabricator (Outsource)
  - Client Receivable (1110) and Fabricator Net Payable (Quotation - Maal Invoice) are tracked cleanly.
*/
const projectSettlementSchema = new mongoose.Schema(
  {
    projectNumber: { type: String, required: true, unique: true },
    projectType: { type: String, enum: ['IN_HOUSE', 'OUTSOURCE'], default: 'IN_HOUSE' },
    date: { type: Date, required: true, default: Date.now },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    reference: { type: String, default: '' },
    notes: { type: String, default: '' },

    // Linked Maal Invoice(s) (can be in Client's name or Outsource Fabricator's name)
    maalInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    maalInvoices: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }],
    maalAllocations: [projectMaalAllocationSchema],
    maalInvoiceAmount: { type: Number, default: 0 },
    maalSettledByProject: { type: Number, default: 0 },
    maalSettledDirectlyInJv: { type: Boolean, default: false },

    // Deal & Revenue separation
    dealAmount: { type: Number, required: true, min: 0 }, // Total Client Quotation / Deal
    projectCharges: { type: Number, default: 0 }, // Project Revenue above Maal (dealAmount - maalInvoiceAmount)

    // Outsource Fabricator details (used when projectType === 'OUTSOURCE')
    fabricatorName: { type: String, default: '' },
    fabricatorAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
    fabricatorQuotation: { type: Number, default: 0 }, // e.g. Rashid Quotation 364,281
    fabricatorNetCost: { type: Number, default: 0 }, // e.g. 364,281 - 274,898 = 89,383
    fabricatorPaidAmount: { type: Number, default: 0 },
    fabricatorPaidFromBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    fabricatorBalanceDue: { type: Number, default: 0 }, // Remaining to pay fabricator when work completes

    // Direct project expenses (Hardware, Labour, Transport, etc.)
    expenses: [projectExpenseSchema],
    totalExpenses: { type: Number, default: 0 },

    // Net Commission / Project Margin (credited to 4500 Commission Income)
    netProfit: { type: Number, default: 0 },

    // Initial Client Advance / Payments
    cashAmount: { type: Number, default: 0, min: 0 },
    cashBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    bankAmount: { type: Number, default: 0, min: 0 },
    bankBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    expensePaidFromBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },

    incomeAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    receivableAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },

    clientPaidTotal: { type: Number, default: 0 },
    clientBalance: { type: Number, default: 0 },

    receipts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Receipt' }],
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    journalEntries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' }],
    paymentLogs: [projectPaymentLogSchema],

    status: { type: String, enum: ['POSTED', 'VOID'], default: 'POSTED' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

projectSettlementSchema.index({ date: 1 });
projectSettlementSchema.index({ customer: 1 });

module.exports = mongoose.model('ProjectSettlement', projectSettlementSchema);
