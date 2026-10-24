import { setMailTransportForTests } from './mailer.js';

export function configureTestMail() {
  setMailTransportForTests({ sendMail: async () => ({ accepted: ['test@example.test'] }) });
}

export async function grantFixtureAccess(database, userId, plan = 'pro') {
  await database.query(`INSERT INTO user_licenses(user_id,plan,granted_at) VALUES($1,$2,NOW())
    ON CONFLICT(user_id) DO UPDATE SET plan=$2,granted_at=NOW(),revoked_at=NULL`, [userId, plan]);
}
