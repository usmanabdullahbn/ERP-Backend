const Role = require('../models/Role');

const PERMISSION_CATALOG = [
  'sales.view', 'sales.manage',
  'purchases.view', 'purchases.manage',
  'inventory.view', 'inventory.manage',
  'banking.view', 'banking.manage',
  'accounting.view', 'accounting.manage',
  'reports.view',
  'users.manage'
];

exports.catalog = (req, res) => res.json(PERMISSION_CATALOG);

exports.list = async (req, res, next) => {
  try {
    const roles = await Role.find().sort({ name: 1 });
    res.json(roles);
  } catch (err) {
    next(err);
  }
};

exports.create = async (req, res, next) => {
  try {
    const { name, description, permissions } = req.body;
    const role = await Role.create({ name, description, permissions });
    res.status(201).json(role);
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found.' });
    if (role.isSystem) {
      return res.status(400).json({ message: 'System roles cannot be modified.' });
    }
    const { name, description, permissions } = req.body;
    if (name !== undefined) role.name = name;
    if (description !== undefined) role.description = description;
    if (permissions !== undefined) role.permissions = permissions;
    await role.save();
    res.json(role);
  } catch (err) {
    next(err);
  }
};

exports.remove = async (req, res, next) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ message: 'Role not found.' });
    if (role.isSystem) {
      return res.status(400).json({ message: 'System roles cannot be deleted.' });
    }
    await role.deleteOne();
    res.json({ message: 'Role deleted.' });
  } catch (err) {
    next(err);
  }
};
