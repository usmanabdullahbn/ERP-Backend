const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const { nextNumber } = require('../services/numberSequence');
const { moveStockWithJournal } = require('../services/stockAccounting');
const { withTransaction, httpError } = require('../services/transaction');

exports.list = async (req, res, next) => {
  try {
    const products = await Product.find().populate('stockByWarehouse.warehouse', 'name code').sort({ name: 1 });
    res.json(products);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id).populate('stockByWarehouse.warehouse', 'name code');
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    res.json(product);
  } catch (err) {
    next(err);
  }
};

exports.movements = async (req, res, next) => {
  try {
    const movements = await StockMovement.find({ product: req.params.id })
      .populate('warehouse', 'name code')
      .sort({ date: -1 });
    res.json(movements);
  } catch (err) {
    next(err);
  }
};

exports.adjustments = async (req, res, next) => {
  try {
    const movements = await StockMovement.find({ sourceType: 'ADJUSTMENT' })
      .populate('product', 'name sku unit')
      .populate('warehouse', 'name code')
      .sort({ date: -1 })
      .limit(200);
    res.json(movements);
  } catch (err) {
    next(err);
  }
};

// Fields a product form may set. Stock levels are never taken from the
// request — they only change through stock movements.
const EDITABLE_FIELDS = ['sku', 'name', 'category', 'unit', 'altUnit', 'altUnitFactor', 'type', 'costPrice', 'salePrice', 'taxRate', 'reorderLevel', 'isActive'];
const pickEditable = (body) => Object.fromEntries(EDITABLE_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

exports.create = async (req, res, next) => {
  try {
    const productId = await withTransaction(async () => {
      const fields = pickEditable(req.body);
      if (!fields.sku) fields.sku = await nextNumber('product', 'SKU', 5);
      const openingStock = Number(req.body.openingStock || 0);

      const [product] = await Product.create([fields]);

      // Optional opening stock, posted against the default warehouse
      if (openingStock > 0 && product.type === 'STOCK') {
        const defaultWarehouse = await Warehouse.findOne({ isDefault: true });
        if (defaultWarehouse) {
          await moveStockWithJournal({
            product: product._id,
            warehouse: defaultWarehouse._id,
            direction: 'IN',
            quantity: openingStock,
            unitCost: product.costPrice,
            sourceType: 'OPENING_STOCK',
            sourceId: product._id,
            note: `Opening stock — ${product.name}`,
            createdBy: req.user._id
          });
        }
      }
      return product._id;
    });

    const populated = await Product.findById(productId).populate('stockByWarehouse.warehouse', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    await withTransaction(async () => {
      const current = await Product.findById(req.params.id);
      if (!current) throw httpError(404, 'Product not found.');

      const product = await Product.findByIdAndUpdate(req.params.id, pickEditable(req.body), { new: true, runValidators: true });
      const { openingStock } = req.body;

      // "Opening stock" on the edit form is the desired total; the difference
      // is posted to the default warehouse, with its journal entry.
      if (product.type === 'STOCK' && openingStock !== undefined && openingStock !== null && openingStock !== '') {
        const defaultWarehouse = await Warehouse.findOne({ isDefault: true });
        if (defaultWarehouse) {
          const delta = Number(openingStock) - Number(current.totalStock || 0);
          if (delta !== 0) {
            await moveStockWithJournal({
              product: product._id,
              warehouse: defaultWarehouse._id,
              direction: delta > 0 ? 'IN' : 'OUT',
              quantity: Math.abs(delta),
              sourceType: 'OPENING_STOCK',
              sourceId: product._id,
              note: `Opening stock update — ${product.name}`,
              createdBy: req.user._id
            });
          }
        }
      }
    });

    const populated = await Product.findById(req.params.id).populate('stockByWarehouse.warehouse', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.adjustStock = async (req, res, next) => {
  try {
    const { warehouse, direction, quantity, note, date } = req.body;
    if (!warehouse || !direction || !quantity) {
      return res.status(400).json({ message: 'warehouse, direction and quantity are required.' });
    }
    const product = await withTransaction(() => moveStockWithJournal({
      product: req.params.id,
      warehouse,
      direction,
      quantity: Number(quantity),
      sourceType: 'ADJUSTMENT',
      sourceId: null,
      note,
      createdBy: req.user._id,
      date
    }));
    res.json(product);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const hasMovements = await StockMovement.exists({ product: req.params.id });
    if (hasMovements) {
      return res.status(400).json({ message: 'Cannot delete a product with stock history. Deactivate instead.' });
    }
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found.' });
    res.json({ message: 'Product deleted.' });
  } catch (err) {
    next(err);
  }
};
