const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/reportController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect, requirePermission('reports.view'));
router.get('/trial-balance', ctrl.trialBalance);
router.get('/profit-and-loss', ctrl.profitAndLoss);
router.get('/balance-sheet', ctrl.balanceSheet);
router.get('/stock-summary', ctrl.stockSummary);
router.get('/customer-ledger', ctrl.customerLedger);
router.get('/supplier-ledger', ctrl.supplierLedger);
router.get('/aged-receivables', ctrl.agedReceivables);
router.get('/aged-payables', ctrl.agedPayables);

module.exports = router;
