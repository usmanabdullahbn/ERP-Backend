const Assembly = require('../models/Assembly');
const BillOfMaterial = require('../models/BillOfMaterial');
const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');
const { nextNumber } = require('../services/numberSequence');
const { recordMovement, getStockLevel } = require('../services/inventoryService');
const { round2 } = require('../services/ledgerService');

const populateOpts = [
  { path: 'product', select: 'name sku unit' },
  { path: 'warehouse', select: 'name code' }
];

exports.list = async (req, res, next) => {
  try {
    const assemblies = await Assembly.find().populate(populateOpts).sort({ date: -1 });
    res.json(assemblies);
  } catch (err) {
    next(err);
  }
};

exports.get = async (req, res, next) => {
  try {
    const assembly = await Assembly.findById(req.params.id)
      .populate(populateOpts)
      .populate('components.product', 'name sku unit');
    if (!assembly) return res.status(404).json({ message: 'Assembly not found.' });
    res.json(assembly);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { product, warehouse, quantity, date, note } = req.body;
    if (!product || !warehouse || !quantity || quantity <= 0) {
      return res.status(400).json({ message: 'Product, warehouse and a positive quantity are required.' });
    }

    const [productDoc, warehouseDoc, bom] = await Promise.all([
      Product.findById(product),
      Warehouse.findById(warehouse),
      BillOfMaterial.findOne({ product }).populate('components.component')
    ]);
    if (!productDoc) return res.status(400).json({ message: 'Selected product does not exist.' });
    if (!warehouseDoc) return res.status(400).json({ message: 'Selected warehouse does not exist.' });
    if (!bom || !bom.components.length) {
      return res.status(400).json({ message: 'This product has no Bill of Materials — define one before recording production.' });
    }

    // Pre-check every component's stock before touching anything: movements
    // aren't wrapped in a DB transaction, so validating up front keeps a
    // rejected run from partially consuming components.
    const shortages = [];
    for (const c of bom.components) {
      const required = round2(c.quantity * quantity);
      const available = await getStockLevel(c.component._id, warehouse);
      if (available < required) {
        shortages.push(`${c.component.name} (need ${required}, have ${available})`);
      }
    }
    if (shortages.length) {
      return res.status(400).json({ message: `Insufficient component stock — ${shortages.join('; ')}.` });
    }

    let totalCost = 0;
    const components = bom.components.map((c) => {
      const quantityUsed = round2(c.quantity * quantity);
      const unitCost = c.component.costPrice || 0;
      totalCost += round2(quantityUsed * unitCost);
      return { product: c.component._id, quantityPerUnit: c.quantity, quantityUsed, unitCost };
    });
    const unitCost = round2(totalCost / quantity);
    const assemblyNumber = await nextNumber('assembly', 'ASM');

    const assembly = await Assembly.create({
      assemblyNumber,
      product,
      warehouse,
      quantity,
      components,
      unitCost,
      totalCost: round2(totalCost),
      date: date || Date.now(),
      note,
      status: 'POSTED',
      createdBy: req.user._id
    });

    try {
      for (const c of components) {
        await recordMovement({
          product: c.product,
          warehouse,
          direction: 'OUT',
          quantity: c.quantityUsed,
          unitCost: c.unitCost,
          sourceType: 'ASSEMBLY',
          sourceId: assembly._id,
          note: `Consumed for production ${assemblyNumber} (${productDoc.name})`,
          createdBy: req.user._id,
          date: assembly.date
        });
      }

      await recordMovement({
        product,
        warehouse,
        direction: 'IN',
        quantity,
        unitCost,
        sourceType: 'ASSEMBLY',
        sourceId: assembly._id,
        note: `Produced via assembly ${assemblyNumber}`,
        createdBy: req.user._id,
        date: assembly.date
      });

      // Roll the components' consumption cost into the finished product's
      // cost price — same "last-cost" convention used when posting bills.
      productDoc.costPrice = unitCost;
      await productDoc.save();
    } catch (err) {
      await Assembly.findByIdAndDelete(assembly._id);
      throw err;
    }

    const populated = await Assembly.findById(assembly._id).populate(populateOpts);
    res.status(201).json(populated);
  } catch (err) {
    next(err);
  }
};

exports.void = async (req, res, next) => {
  try {
    const assembly = await Assembly.findById(req.params.id);
    if (!assembly) return res.status(404).json({ message: 'Assembly not found.' });
    if (assembly.status === 'VOID') {
      return res.status(400).json({ message: 'This assembly has already been voided.' });
    }

    // Remove the finished good first — if it's since been sold or consumed
    // elsewhere this fails with an insufficient-stock error before any
    // component is restored, leaving the assembly untouched.
    await recordMovement({
      product: assembly.product,
      warehouse: assembly.warehouse,
      direction: 'OUT',
      quantity: assembly.quantity,
      unitCost: assembly.unitCost,
      sourceType: 'ASSEMBLY_VOID',
      sourceId: assembly._id,
      note: `Void of assembly ${assembly.assemblyNumber}`,
      createdBy: req.user._id
    });

    for (const c of assembly.components) {
      await recordMovement({
        product: c.product,
        warehouse: assembly.warehouse,
        direction: 'IN',
        quantity: c.quantityUsed,
        unitCost: c.unitCost,
        sourceType: 'ASSEMBLY_VOID',
        sourceId: assembly._id,
        note: `Void of assembly ${assembly.assemblyNumber}`,
        createdBy: req.user._id
      });
    }

    assembly.status = 'VOID';
    await assembly.save();

    const populated = await Assembly.findById(assembly._id).populate(populateOpts);
    res.json(populated);
  } catch (err) {
    next(err);
  }
};
