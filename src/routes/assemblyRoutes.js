const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/assemblyController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('inventory.view', 'inventory.manage'), ctrl.list);
router.get('/:id', requirePermission('inventory.view', 'inventory.manage'), ctrl.get);
router.post('/', requirePermission('inventory.manage'), ctrl.create);
router.post('/:id/void', requirePermission('inventory.manage'), ctrl.void);

module.exports = router;
