const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/warehouseController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
// Read-only list: sales/purchase forms need it for line warehouses, reports for filters.
router.get('/', requirePermission('inventory.view', 'inventory.manage', 'sales.view', 'sales.manage', 'purchases.view', 'purchases.manage', 'reports.view'), ctrl.list);
router.post('/', requirePermission('inventory.manage'), ctrl.create);
router.put('/:id', requirePermission('inventory.manage'), ctrl.update);
router.delete('/:id', requirePermission('inventory.manage'), ctrl.remove);

module.exports = router;
