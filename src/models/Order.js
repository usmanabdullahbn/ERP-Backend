const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    description: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 0.001 },
    unitPrice: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0 },
    discountRate: { type: Number, default: 0, min: 0, max: 100 },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    lineTotal: { type: Number, required: true }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    date: { type: Date, required: true, default: Date.now },
    dueDate: { type: Date },
    items: { type: [orderItemSchema], default: [] },
    subTotal: { type: Number, required: true, default: 0 },
    taxTotal: { type: Number, required: true, default: 0 },
    grandTotal: { type: Number, required: true, default: 0 },
    amountInvoiced: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['DRAFT', 'OPEN', 'PARTIALLY_INVOICED', 'INVOICED', 'CANCELLED'],
      default: 'DRAFT'
    },
    notes: { type: String, default: '' },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

orderSchema.virtual('balanceDue').get(function () {
  return Math.max(0, this.grandTotal - this.amountInvoiced);
});
orderSchema.set('toJSON', { virtuals: true });
orderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Order', orderSchema);
