const mongoose = require('mongoose');

/*
  stockByWarehouse keeps a running quantity per warehouse for fast reads.
  The authoritative audit trail of stock movement lives in StockMovement;
  this field is a maintained cache updated transactionally alongside it.
*/
const stockLevelSchema = new mongoose.Schema(
  {
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    quantity: { type: Number, default: 0 }
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, default: '' },
    unit: { type: String, default: 'pcs' },
    type: { type: String, enum: ['STOCK', 'NON_STOCK', 'SERVICE'], default: 'STOCK' },
    costPrice: { type: Number, default: 0 },
    salePrice: { type: Number, default: 0 },
    taxRate: { type: Number, default: 0 }, // percentage
    reorderLevel: { type: Number, default: 0 },
    stockByWarehouse: { type: [stockLevelSchema], default: [] },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

productSchema.virtual('totalStock').get(function () {
  return (this.stockByWarehouse || []).reduce((sum, s) => sum + s.quantity, 0);
});
productSchema.set('toJSON', { virtuals: true });
productSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);
