function normalizeWhatsAppNumber(value) {
  if (!value) return '';

  let digits = String(value).trim();
  digits = digits.replace(/\s+/g, '').replace(/[^\d+]/g, '');

  if (!digits) return '';
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0')) return `+92${digits.slice(1)}`;
  if (digits.length === 10) return `+92${digits}`;
  return `+${digits}`;
}

async function sendWhatsAppMessage(to, body) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    console.error('[whatsapp] cannot send, access token or phone number ID missing');
    return { ok: false, error: 'WhatsApp not configured' };
  }

  const recipient = normalizeWhatsAppNumber(to);
  const response = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'text',
      text: { body }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    console.error('[whatsapp] send failed:', data);
    return { ok: false, error: data?.error?.message || 'Failed to send WhatsApp message', details: data };
  }

  return { ok: true, data };
}

module.exports = { sendWhatsAppMessage, normalizeWhatsAppNumber };
