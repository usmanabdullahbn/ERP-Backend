const Warehouse = require('../models/Warehouse');
const { nextNumber } = require('../services/numberSequence');

exports.list = async (req, res, next) => {
  try {
    const warehouses = await Warehouse.find().sort({ name: 1 });
    res.json(warehouses);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    let { code, name, location, isDefault } = req.body;
    if (!code) code = await nextNumber('warehouse', 'WH', 3);
    if (isDefault) await Warehouse.updateMany({}, { isDefault: false });
    const warehouse = await Warehouse.create({ code, name, location, isDefault });
    res.status(201).json(warehouse);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    if (req.body.isDefault) await Warehouse.updateMany({}, { isDefault: false });
    const warehouse = await Warehouse.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!warehouse) return res.status(404).json({ message: 'Warehouse not found.' });
    res.json(warehouse);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const warehouse = await Warehouse.findByIdAndDelete(req.params.id);
    if (!warehouse) return res.status(404).json({ message: 'Warehouse not found.' });
    res.json({ message: 'Warehouse deleted.' });
  } catch (err) {
    next(err);
  }
};
