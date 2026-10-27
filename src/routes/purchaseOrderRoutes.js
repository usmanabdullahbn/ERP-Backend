const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/purchaseOrderController');
const { protect } = require('../middleware/auth');
const { requirePermission, requireAdmin } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('purchases.view', 'purchases.manage'), ctrl.list);
router.get('/:id', requirePermission('purchases.view', 'purchases.manage'), ctrl.get);
router.post('/', requirePermission('purchases.manage'), ctrl.create);
router.put('/:id', requirePermission('purchases.manage'), ctrl.update);
router.delete('/:id', requirePermission('purchases.manage'), ctrl.remove);
// Creating a bill is admin-only (see billRoutes), so converting a purchase order into one is too.
router.post('/:id/to-bill', requireAdmin, ctrl.toBill);

module.exports = router;
