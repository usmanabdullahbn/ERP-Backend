const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');
const Warehouse = require('../models/Warehouse');
const { nextNumber } = require('../services/numberSequence');
const { recordMovement } = require('../services/inventoryService');

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

exports.create = async (req, res, next) => {
  try {
    let { sku, name, category, unit, type, costPrice, salePrice, taxRate, reorderLevel, openingStock } = req.body;
    if (!sku) sku = await nextNumber('product', 'SKU', 5);

    const product = await Product.create({
      sku, name, category, unit, type, costPrice, salePrice, taxRate, reorderLevel
    });

    // Optional opening stock, posted against the default warehouse
    if (openingStock && openingStock > 0 && type === 'STOCK') {
      const defaultWarehouse = await Warehouse.findOne({ isDefault: true });
      if (defaultWarehouse) {
        await recordMovement({
          product: product._id,
          warehouse: defaultWarehouse._id,
          direction: 'IN',
          quantity: openingStock,
          unitCost: costPrice,
          sourceType: 'OPENING_STOCK',
          sourceId: product._id,
          note: 'Opening stock',
          createdBy: req.user._id
        });
      }
    }

    const populated = await Product.findById(product._id).populate('stockByWarehouse.warehouse', 'name code');
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const { openingStock, ...rest } = req.body;
    const current = await Product.findById(req.params.id);
    if (!current) return res.status(404).json({ message: 'Product not found.' });

    const product = await Product.findByIdAndUpdate(req.params.id, rest, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    if (product.type === 'STOCK' && openingStock !== undefined && openingStock !== null) {
      const defaultWarehouse = await Warehouse.findOne({ isDefault: true });
      if (defaultWarehouse) {
        const target = Number(openingStock);
        const currentStock = Number(current.totalStock || 0);
        const delta = target - currentStock;

        if (delta > 0) {
          await recordMovement({
            product: product._id,
            warehouse: defaultWarehouse._id,
            direction: 'IN',
            quantity: delta,
            unitCost: product.costPrice,
            sourceType: 'OPENING_STOCK',
            sourceId: product._id,
            note: 'Opening stock update',
            createdBy: req.user._id
          });
        } else if (delta < 0) {
          await recordMovement({
            product: product._id,
            warehouse: defaultWarehouse._id,
            direction: 'OUT',
            quantity: Math.abs(delta),
            unitCost: product.costPrice,
            sourceType: 'OPENING_STOCK',
            sourceId: product._id,
            note: 'Opening stock update',
            createdBy: req.user._id
          });
        }
      }
    }

    const populated = await Product.findById(product._id).populate('stockByWarehouse.warehouse', 'name code');
    res.json(populated);
  } catch (err) {
    next(err);
  }
};

exports.adjustStock = async (req, res, next) => {
  try {
    const { warehouse, direction, quantity, note } = req.body;
    if (!warehouse || !direction || !quantity) {
      return res.status(400).json({ message: 'warehouse, direction and quantity are required.' });
    }
    const product = await recordMovement({
      product: req.params.id,
      warehouse,
      direction,
      quantity,
      sourceType: 'ADJUSTMENT',
      sourceId: null,
      note,
      createdBy: req.user._id
    });
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
