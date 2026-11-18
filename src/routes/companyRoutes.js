const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/companyController');
const { protect } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/rbac');

router.use(protect);
router.get('/', ctrl.list);
router.post('/', requireAdmin, ctrl.create);
router.put('/:id', requireAdmin, ctrl.update);

module.exports = router;
