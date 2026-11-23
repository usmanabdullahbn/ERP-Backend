const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/projectSettlementController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

const canView = requirePermission('accounting.view', 'accounting.manage', 'sales.view', 'sales.manage');
const canManage = requirePermission('accounting.manage', 'sales.manage');

router.use(protect, canView);
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);
router.post('/', canManage, ctrl.create);
router.put('/:id', canManage, ctrl.update);
router.post('/:id/receive-client', canManage, ctrl.receiveClientPayment);
router.post('/:id/pay-fabricator', canManage, ctrl.payFabricatorBalance);
router.post('/:id/void', canManage, ctrl.voidSettlement);

module.exports = router;
