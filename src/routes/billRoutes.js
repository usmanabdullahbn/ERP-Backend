const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/billController');
const { protect } = require('../middleware/auth');
const { requirePermission, requireAdmin } = require('../middleware/rbac');

router.use(protect);
router.get('/', requirePermission('purchases.view', 'purchases.manage'), ctrl.list);
router.get('/:id', requirePermission('purchases.view', 'purchases.manage'), ctrl.get);
router.post('/', requireAdmin, ctrl.create);
router.put('/:id', requireAdmin, ctrl.update);
router.post('/:id/post', requireAdmin, ctrl.post);
router.post('/:id/void', requireAdmin, ctrl.void);
router.delete('/:id', requireAdmin, ctrl.remove);

module.exports = router;
