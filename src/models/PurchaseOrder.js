const mongoose = require('mongoose');

const poItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    description: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 0.001 },
    unitCost: { type: Number, required: true, min: 0 },
    taxRate: { type: Number, default: 0 },
    discountRate: { type: Number, default: 0, min: 0, max: 100 },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    lineTotal: { type: Number, required: true }
  },
  { _id: false }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: { type: String, required: true, unique: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    date: { type: Date, required: true, default: Date.now },
    dueDate: { type: Date },
    items: { type: [poItemSchema], default: [] },
    subTotal: { type: Number, required: true, default: 0 },
    taxTotal: { type: Number, required: true, default: 0 },
    grandTotal: { type: Number, required: true, default: 0 },
    amountBilled: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['DRAFT', 'OPEN', 'PARTIALLY_BILLED', 'BILLED', 'CANCELLED'],
      default: 'DRAFT'
    },
    notes: { type: String, default: '' },
    bill: { type: mongoose.Schema.Types.ObjectId, ref: 'Bill', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

purchaseOrderSchema.virtual('balanceDue').get(function () {
  return Math.max(0, this.grandTotal - this.amountBilled);
});
purchaseOrderSchema.set('toJSON', { virtuals: true });
purchaseOrderSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
