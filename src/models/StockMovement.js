const mongoose = require('mongoose');

/*
  Immutable audit trail of every stock in/out. This is the source of truth;
  Product.stockByWarehouse is a derived cache for fast lookups.
*/
const stockMovementSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    direction: { type: String, enum: ['IN', 'OUT'], required: true },
    quantity: { type: Number, required: true, min: 0 },
    unitCost: { type: Number, default: 0 },
    sourceType: {
      type: String,
      enum: ['INVOICE', 'BILL', 'INVOICE_VOID', 'BILL_VOID', 'ADJUSTMENT', 'OPENING_STOCK', 'TRANSFER', 'ASSEMBLY', 'ASSEMBLY_VOID'],
      required: true
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    date: { type: Date, default: Date.now },
    note: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('StockMovement', stockMovementSchema);
