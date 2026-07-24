const mongoose = require('mongoose');

/*
  Permissions are simple string keys checked by the rbac middleware, e.g.:
  'sales.view', 'sales.manage', 'purchases.manage', 'inventory.manage',
  'banking.manage', 'accounting.manage', 'reports.view', 'users.manage'
*/
const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    permissions: [{ type: String }],
    isSystem: { type: Boolean, default: false } // system roles cannot be deleted
  },
  { timestamps: true }
);

module.exports = mongoose.model('Role', roleSchema);
