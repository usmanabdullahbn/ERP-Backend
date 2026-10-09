const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/journalController');
const { protect } = require('../middleware/auth');
const { requirePermission, requireAdmin } = require('../middleware/rbac');

router.use(protect, requirePermission('accounting.view', 'accounting.manage'));
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/manual', requireAdmin, ctrl.createManual);
router.put('/:id', requireAdmin, ctrl.update);
router.delete('/:id', requireAdmin, ctrl.remove);

module.exports = router;
