const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/accountController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('accounting.view', 'accounting.manage'), ctrl.list);
router.post('/', requirePermission('accounting.manage'), ctrl.create);
router.put('/:id', requirePermission('accounting.manage'), ctrl.update);
router.delete('/:id', requirePermission('accounting.manage'), ctrl.remove);

module.exports = router;
