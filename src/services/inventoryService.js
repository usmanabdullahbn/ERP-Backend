const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');

/*
  Records an immutable stock movement AND updates the cached quantity on the
  Product document for fast reads (e.g. dashboard, availability checks).
*/
async function recordMovement({ product, warehouse, direction, quantity, unitCost, sourceType, sourceId, note, createdBy }) {
  await StockMovement.create({
    product,
    warehouse,
    direction,
    quantity,
    unitCost: unitCost || 0,
    sourceType,
    sourceId,
    note,
    createdBy
  });

  const delta = direction === 'IN' ? quantity : -quantity;
  const prod = await Product.findById(product);
  if (!prod) throw new Error('Product not found while recording stock movement.');

  const existing = prod.stockByWarehouse.find((s) => s.warehouse.toString() === warehouse.toString());
  if (existing) {
    existing.quantity += delta;
  } else {
    prod.stockByWarehouse.push({ warehouse, quantity: delta });
  }
  await prod.save();

  return prod;
}

async function getStockLevel(productId, warehouseId) {
  const prod = await Product.findById(productId);
  if (!prod) return 0;
  const entry = prod.stockByWarehouse.find((s) => s.warehouse.toString() === warehouseId.toString());
  return entry ? entry.quantity : 0;
}

module.exports = { recordMovement, getStockLevel };
