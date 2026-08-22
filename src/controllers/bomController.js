const BillOfMaterial = require('../models/BillOfMaterial');
const Product = require('../models/Product');

async function validateComponents(productId, components) {
  if (!components || !components.length) {
    const err = new Error('At least one component is required.');
    err.statusCode = 400;
    throw err;
  }
  if (components.some((c) => String(c.component) === String(productId))) {
    const err = new Error('A product cannot be a component of its own Bill of Materials.');
    err.statusCode = 400;
    throw err;
  }
  const ids = [...new Set(components.map((c) => String(c.component)))];
  const found = await Product.find({ _id: { $in: ids } });
  if (found.length !== ids.length) {
    const err = new Error('One or more components reference a product that does not exist.');
    err.statusCode = 400;
    throw err;
  }
}

const populateOpts = [
  { path: 'product', select: 'name sku unit' },
  { path: 'components.component', select: 'name sku unit costPrice' }
];

exports.list = async (req, res, next) => {
  try {
    const boms = await BillOfMaterial.find().populate(populateOpts).sort({ createdAt: -1 });
    res.json(boms);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const bom = await BillOfMaterial.findById(req.params.id).populate(populateOpts);
    if (!bom) return res.status(404).json({ message: 'Bill of Materials not found.' });
    res.json(bom);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { product, components, notes } = req.body;
    if (!product) return res.status(400).json({ message: 'A finished product is required.' });

    const productDoc = await Product.findById(product);
    if (!productDoc) return res.status(400).json({ message: 'Selected product does not exist.' });

    const existing = await BillOfMaterial.findOne({ product });
    if (existing) {
      return res.status(400).json({ message: 'This product already has a Bill of Materials — edit it instead.' });
    }

    await validateComponents(product, components);

    const bom = await BillOfMaterial.create({ product, components, notes });
    const populated = await BillOfMaterial.findById(bom._id).populate(populateOpts);
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const bom = await BillOfMaterial.findById(req.params.id);
    if (!bom) return res.status(404).json({ message: 'Bill of Materials not found.' });

    const { components, notes, isActive } = req.body;
    await validateComponents(bom.product, components);

    bom.components = components;
    if (notes !== undefined) bom.notes = notes;
    if (isActive !== undefined) bom.isActive = isActive;
    await bom.save();

    const populated = await BillOfMaterial.findById(bom._id).populate(populateOpts);
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const bom = await BillOfMaterial.findByIdAndDelete(req.params.id);
    if (!bom) return res.status(404).json({ message: 'Bill of Materials not found.' });
    res.json({ message: 'Bill of Materials deleted.' });
  } catch (err) {
    next(err);
  }
};
