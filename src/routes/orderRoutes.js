const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/orderController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('sales.view', 'sales.manage'), ctrl.list);
router.get('/:id', requirePermission('sales.view', 'sales.manage'), ctrl.get);
router.post('/', requirePermission('sales.manage'), ctrl.create);
router.put('/:id', requirePermission('sales.manage'), ctrl.update);
router.delete('/:id', requirePermission('sales.manage'), ctrl.remove);
router.post('/:id/to-invoice', requirePermission('sales.manage'), ctrl.toInvoice);

module.exports = router;
