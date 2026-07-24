const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/productController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('inventory.view', 'inventory.manage', 'sales.view', 'sales.manage', 'purchases.view', 'purchases.manage'), ctrl.list);
router.get('/:id', requirePermission('inventory.view', 'inventory.manage'), ctrl.get);
router.get('/:id/movements', requirePermission('inventory.view', 'inventory.manage'), ctrl.movements);
router.post('/', requirePermission('inventory.manage'), ctrl.create);
router.put('/:id', requirePermission('inventory.manage'), ctrl.update);
router.post('/:id/adjust', requirePermission('inventory.manage'), ctrl.adjustStock);
router.delete('/:id', requirePermission('inventory.manage'), ctrl.remove);

module.exports = router;
