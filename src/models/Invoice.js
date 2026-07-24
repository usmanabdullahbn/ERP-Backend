const mongoose = require('mongoose');

const invoiceItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    description: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 0.001 },
    unitPrice: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0 },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    lineTotal: { type: Number, required: true } // qty * unitPrice + tax
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    date: { type: Date, required: true, default: Date.now },
    dueDate: { type: Date },
    items: { type: [invoiceItemSchema], required: true },
    subTotal: { type: Number, required: true },
    taxTotal: { type: Number, required: true, default: 0 },
    grandTotal: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'VOID'],
      default: 'DRAFT'
    },
    notes: { type: String, default: '' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

invoiceSchema.virtual('balanceDue').get(function () {
  return Math.max(0, this.grandTotal - this.amountPaid);
});
invoiceSchema.set('toJSON', { virtuals: true });
invoiceSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
