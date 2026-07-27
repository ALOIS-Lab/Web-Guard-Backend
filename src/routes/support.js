const express = require('express');
const { answerSupport } = require('../services/support');

const router = express.Router();

router.post('/chat', async (req, res) => {
  const { message, history } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'message is too long (max 2000 characters)' });
  }

  try {
    const result = await answerSupport(message, Array.isArray(history) ? history : []);
    res.json({
      reply: result.reply,
      source: result.source,
      available_24_7: true,
      assistant: 'WebGuard Support',
    });
  } catch (err) {
    console.error('[support]', err);
    res.status(500).json({ error: 'Support chat failed. Please try again.' });
  }
});

module.exports = router;
