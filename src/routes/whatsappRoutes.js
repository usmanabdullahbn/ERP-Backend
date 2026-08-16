const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/whatsappController');

router.post('/test', ctrl.sendTest);
router.get('/webhook', ctrl.verifyWebhook);
router.post('/webhook', ctrl.receiveWebhook);

module.exports = router;
