const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/bomController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('inventory.view', 'inventory.manage'), ctrl.list);
router.get('/:id', requirePermission('inventory.view', 'inventory.manage'), ctrl.get);
router.post('/', requirePermission('inventory.manage'), ctrl.create);
router.put('/:id', requirePermission('inventory.manage'), ctrl.update);
router.delete('/:id', requirePermission('inventory.manage'), ctrl.remove);

module.exports = router;
