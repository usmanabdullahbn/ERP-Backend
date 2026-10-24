const Product = require('../models/Product');
const StockMovement = require('../models/StockMovement');

/*
  Records an immutable stock movement AND updates the cached quantity on the
  Product document for fast reads (e.g. dashboard, availability checks).

  The quantity update is done with atomic Mongo operators ($inc / $push)
  rather than find→mutate→save, so two concurrent movements against the same
  product/warehouse can't lose an update. OUT movements are additionally
  gated by a query condition (quantity >= requested), so the whole
  check-and-decrement happens as one atomic operation — stock can never be
  driven negative, even under concurrent requests.
*/
async function recordMovement({ product, warehouse, direction, quantity, unitCost, sourceType, sourceId, note, createdBy, date }) {
  if (!quantity || quantity <= 0) {
    const err = new Error('Stock movement quantity must be greater than zero.');
    err.statusCode = 400;
    throw err;
  }
  // Normalise direction to upper-case to avoid case-sensitivity bugs
  direction = String(direction || '').toUpperCase();
  const delta = direction === 'IN' ? quantity : -quantity;
  let prod;

  if (direction === 'OUT') {
    prod = await Product.findOneAndUpdate(
      {
        _id: product,
        stockByWarehouse: { $elemMatch: { warehouse, quantity: { $gte: quantity } } }
      },
      { $inc: { 'stockByWarehouse.$.quantity': delta } },
      { new: true }
    );
    if (!prod) {
      const existing = await Product.findById(product);
      if (!existing) throw new Error('Product not found while recording stock movement.');
      const entry = existing.stockByWarehouse.find((s) => s.warehouse.toString() === warehouse.toString());
      const available = entry ? entry.quantity : 0;
      const err = new Error(
        `Insufficient stock: only ${available} unit(s) of "${existing.name}" available in the selected warehouse (${quantity} requested).`
      );
      err.statusCode = 400;
      throw err;
    }
  } else {
    // IN movement (or other non-OUT) — ensure we never push a negative starting
    // quantity (this could happen if callers passed a mis-cased direction).
    if (delta < 0) {
      const err = new Error('Invalid stock movement: negative quantity for IN movement.');
      err.statusCode = 400;
      throw err;
    }

    prod = await Product.findOneAndUpdate(
      { _id: product, 'stockByWarehouse.warehouse': warehouse },
      { $inc: { 'stockByWarehouse.$.quantity': delta } },
      { new: true }
    );
    if (!prod) {
      prod = await Product.findOneAndUpdate(
        { _id: product },
        { $push: { stockByWarehouse: { warehouse, quantity: delta } } },
        { new: true }
      );
      if (!prod) throw new Error('Product not found while recording stock movement.');
    }
  }

  await StockMovement.create({
    product,
    warehouse,
    direction,
    quantity,
    unitCost: unitCost || 0,
    sourceType,
    sourceId,
    note,
    createdBy,
    date: date || Date.now()
  });

  return prod;
}

/*
  Undoes the movements a failed posting already recorded for one source
  document (e.g. stock added for a bill whose journal then failed), so a
  retry doesn't add the stock a second time. Movements are deleted rather
  than reversed because the posting never happened. Callers pass `since`
  (taken before the posting started) so earlier, legitimate movements for
  the same document are left alone.
*/
async function rollbackMovements({ sourceType, sourceId, since }) {
  const movements = await StockMovement.find({ sourceType, sourceId, createdAt: { $gte: since } });
  for (const m of movements) {
    const delta = m.direction === 'IN' ? -m.quantity : m.quantity;
    await Product.updateOne(
      { _id: m.product, 'stockByWarehouse.warehouse': m.warehouse },
      { $inc: { 'stockByWarehouse.$.quantity': delta } }
    );
    await StockMovement.deleteOne({ _id: m._id });
  }
  return movements.length;
}

async function getStockLevel(productId, warehouseId) {
  const prod = await Product.findById(productId);
  if (!prod) return 0;
  const entry = prod.stockByWarehouse.find((s) => s.warehouse.toString() === warehouseId.toString());
  return entry ? entry.quantity : 0;
}

module.exports = { recordMovement, rollbackMovements, getStockLevel };
