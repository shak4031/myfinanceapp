import nodemailer from 'nodemailer';

let transport;
let testTransport;
export const SUPPORT_EMAIL = 'myfinanceapp.support@gmail.com';

export function setMailTransportForTests(value) {
  testTransport = value;
}

export function mailConfigured() {
  return Boolean(testTransport || (process.env.SMTP_HOST && process.env.SMTP_FROM));
}

function getTransport() {
  if (testTransport) return testTransport;
  if (!mailConfigured()) return null;
  transport ||= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  return transport;
}

export function appOrigin(req) {
  return process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
}

export async function sendPasswordResetEmail(req, user, token, minutes) {
  const mail = getTransport();
  if (!mail) return false;
  // The token is in the URL fragment so it is never sent to the server in request logs.
  const link = `${appOrigin(req)}/#reset-token=${token}`;
  await mail.sendMail({
    from: process.env.SMTP_FROM || 'MyFinanceApp <no-reply@localhost>',
    to: user.email,
    subject: 'Reset your MyFinanceApp password',
    text: `Hi ${user.name},\n\nUse this link within ${minutes} minutes to choose a new password:\n${link}\n\nIf you did not request this, ignore this email. Your password has not changed.`
  });
  return true;
}

export async function sendSecurityNotice(user, subject, text) {
  const mail = getTransport();
  if (!mail || !user?.email) return false;
  await mail.sendMail({ from: process.env.SMTP_FROM || 'MyFinanceApp <no-reply@localhost>', to: user.email, subject, text });
  return true;
}

export async function sendSupportTicketEmail(req, user, ticket) {
  const mail = getTransport();
  if (!mail) throw new Error('Support notification SMTP is not configured.');
  await mail.sendMail({
    from: process.env.SMTP_FROM || `MyFinanceApp <${SUPPORT_EMAIL}>`,
    to: SUPPORT_EMAIL,
    replyTo: user.email,
    subject: `MyFinanceApp support ticket MFA-${ticket.id}`,
    text: `Ticket: MFA-${ticket.id}\nFrom: ${user.name} <${user.email}>\nCategory: ${ticket.category || 'Not specified'}\nStatus: ${{ open: 'Open', in_progress: 'In-Progress', resolved: 'Resolved' }[ticket.status]}\n\n${ticket.description}\n\nManage this ticket in the administrator console:\n${appOrigin(req)}/admin.html\n\nOpening a ticket does not grant access to financial records.`
  });
}
