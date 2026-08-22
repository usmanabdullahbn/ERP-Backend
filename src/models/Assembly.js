const mongoose = require('mongoose');

const assemblyComponentSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantityPerUnit: { type: Number, required: true },
    quantityUsed: { type: Number, required: true },
    unitCost: { type: Number, default: 0 }
  },
  { _id: false }
);

/*
  A single production run: build `quantity` units of `product` by consuming
  its Bill of Materials components out of `warehouse`. `components` is a
  snapshot of the BOM at production time (scaled by quantity) so later BOM
  edits never retroactively change a past run's recorded cost.
*/
const assemblySchema = new mongoose.Schema(
  {
    assemblyNumber: { type: String, required: true, unique: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    quantity: { type: Number, required: true, min: 0.001 },
    components: { type: [assemblyComponentSchema], required: true },
    unitCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0 },
    date: { type: Date, required: true, default: Date.now },
    note: { type: String, default: '' },
    status: { type: String, enum: ['POSTED', 'VOID'], default: 'POSTED' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Assembly', assemblySchema);
