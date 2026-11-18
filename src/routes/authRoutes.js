const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/authController');
const { protect } = require('../middleware/auth');

router.post('/register', ctrl.register);
router.post('/login', ctrl.login);
router.get('/me', protect, ctrl.me);
router.post('/switch-company', protect, ctrl.switchCompany);

module.exports = router;
