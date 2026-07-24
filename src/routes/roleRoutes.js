const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/roleController');
const { protect } = require('../middleware/auth');
const { requirePermission } = require('../middleware/rbac');

router.use(protect);
router.get('/catalog', ctrl.catalog);
router.get('/', ctrl.list);
router.post('/', requirePermission('users.manage'), ctrl.create);
router.put('/:id', requirePermission('users.manage'), ctrl.update);
router.delete('/:id', requirePermission('users.manage'), ctrl.remove);

module.exports = router;
