const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/journalController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect, requirePermission('accounting.view', 'accounting.manage'));
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/manual', requirePermission('accounting.manage'), ctrl.createManual);

module.exports = router;
