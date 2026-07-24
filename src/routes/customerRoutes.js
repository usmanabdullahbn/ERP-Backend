const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/customerController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('sales.view', 'sales.manage'), ctrl.list);
router.get('/:id', requirePermission('sales.view', 'sales.manage'), ctrl.get);
router.get('/:id/statement', requirePermission('sales.view', 'sales.manage'), ctrl.statement);
router.post('/', requirePermission('sales.manage'), ctrl.create);
router.put('/:id', requirePermission('sales.manage'), ctrl.update);
router.delete('/:id', requirePermission('sales.manage'), ctrl.remove);

module.exports = router;
