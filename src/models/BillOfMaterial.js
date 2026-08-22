const mongoose = require('mongoose');

const bomComponentSchema = new mongoose.Schema(
  {
    component: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 0.001 }
  },
  { _id: false }
);

/*
  One BOM per finished product: which components (and how much of each) it
  takes to produce one unit. Assembly runs snapshot this at production time,
  so editing a BOM later never rewrites the recorded cost of past runs.
*/
const billOfMaterialSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, unique: true },
    components: { type: [bomComponentSchema], required: true },
    notes: { type: String, default: '' },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('BillOfMaterial', billOfMaterialSchema);
