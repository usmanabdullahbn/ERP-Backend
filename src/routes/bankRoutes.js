const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/bankController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/accounts', requirePermission('banking.view', 'banking.manage'), ctrl.listAccounts);
router.post('/accounts', requirePermission('banking.manage'), ctrl.createAccount);
router.get('/accounts/:id/balance', requirePermission('banking.view', 'banking.manage'), ctrl.balance);
router.get('/transactions', requirePermission('banking.view', 'banking.manage'), ctrl.transactions);
router.post('/transactions', requirePermission('banking.manage'), ctrl.createTransaction);

module.exports = router;
