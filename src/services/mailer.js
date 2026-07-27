const nodemailer = require('nodemailer');

let transporter = null;

function isValidEmail(value) {
  if (!value || typeof value !== 'string') return false;
  const email = value.trim().toLowerCase();
  if (email.endsWith('@webguard.dev') || email.endsWith('@webguard.local')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_USER || !SMTP_PASS) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST || 'smtp.gmail.com',
    port: Number(SMTP_PORT) || 587,
    secure: false,
    requireTLS: true,
    auth: {
      user: SMTP_USER.trim(),
      pass: SMTP_PASS.replace(/\s+/g, ''),
    },
  });

  return transporter;
}

/** Recipients = alert recipient (custom or account email). */
function alertRecipients(recipientEmail) {
  const list = [];
  const email = String(recipientEmail || '')
    .trim()
    .toLowerCase();
  if (isValidEmail(email)) list.push(email);
  return list;
}

function isMailConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function verifyMailer() {
  const transport = getTransporter();
  if (!transport) {
    console.warn('[mailer] SMTP not configured (set SMTP_USER and SMTP_PASS)');
    return false;
  }
  try {
    await transport.verify();
    console.log('[mailer] SMTP verified — alerts go to each user\'s recipient email');
    return true;
  } catch (err) {
    console.error('[mailer] SMTP verify failed:', err.message);
    return false;
  }
}

async function sendDownAlert({ to, url, statusCode, message, ownerName }) {
  const transport = getTransporter();
  const recipients = alertRecipients(to);

  if (!transport) {
    console.warn('[mailer] SMTP not configured — skipping email to', recipients.join(', ') || '(none)');
    return { skipped: true, recipients };
  }

  if (!recipients.length) {
    console.warn('[mailer] no valid user email to notify');
    return { skipped: true, recipients: [] };
  }

  const from = process.env.SMTP_FROM || `WebGuard <${process.env.SMTP_USER}>`;
  const greeting = ownerName ? `Hi ${ownerName},` : 'Hi,';
  const codeLabel = statusCode != null ? String(statusCode) : 'n/a (connection failed)';

  const text = `${greeting}\n\n${message}\n\nURL: ${url}\nStatus code: ${codeLabel}\n\n— WebGuard · Monitor. Protect. Assure.`;
  const html = `
      <div style="font-family: DM Sans, Segoe UI, sans-serif; line-height: 1.55; color: #0f172a;">
        <div style="max-width: 520px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
          <div style="background: linear-gradient(90deg, #2563eb, #7c3aed); color: #fff; padding: 16px 20px;">
            <strong style="font-size: 16px;">WebGuard Alert</strong>
            <div style="opacity: 0.9; font-size: 12px; margin-top: 4px;">Monitor. Protect. Assure.</div>
          </div>
          <div style="padding: 20px;">
            <p style="margin: 0 0 12px;">${greeting}</p>
            <p style="margin: 0 0 16px;">${message}</p>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
              <tr>
                <td style="padding: 8px 0; color: #64748b;">URL</td>
                <td style="padding: 8px 0; text-align: right;"><a href="${url}">${url}</a></td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b;">Status</td>
                <td style="padding: 8px 0; text-align: right; color: #dc2626; font-weight: 600;">Down</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b;">Status code</td>
                <td style="padding: 8px 0; text-align: right;">${codeLabel}</td>
              </tr>
            </table>
            <p style="margin: 20px 0 0; font-size: 12px; color: #64748b;">
              Sent by WebGuard alert notifications.
            </p>
          </div>
        </div>
      </div>
    `;

  const messageIds = [];
  const errors = [];

  for (const recipient of recipients) {
    try {
      const info = await transport.sendMail({
        from,
        to: recipient,
        subject: `WebGuard Alert: ${url} is down`,
        text,
        html,
      });
      messageIds.push(info.messageId);
      console.log('[mailer] down alert sent to', recipient, 'id=', info.messageId);
    } catch (err) {
      errors.push({ recipient, error: err.message });
      console.error('[mailer] failed sending to', recipient, '—', err.message);
    }
  }

  if (!messageIds.length) {
    const err = new Error(errors.map((e) => e.error).join('; ') || 'All alert emails failed');
    err.details = errors;
    throw err;
  }

  return { messageId: messageIds[0], messageIds, recipients, errors };
}

module.exports = {
  sendDownAlert,
  alertRecipients,
  isMailConfigured,
  verifyMailer,
  isValidEmail,
};
