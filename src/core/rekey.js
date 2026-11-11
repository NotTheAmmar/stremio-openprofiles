import { accountCipher } from './repo.js';

/**
 * One-time upgrade of data written before accounts existed (enc_version 1):
 * those blobs were bound only to their purpose ("library"), not to an
 * account. Re-encrypt every blob of such an account with the account-bound
 * scheme, in one transaction per account. A blob that can't be decrypted
 * stops the upgrade for that account and leaves it untouched (and loud),
 * rather than half-converting it.
 */
export async function upgradeLegacyEncryption(db, cipher, log) {
  const legacy = await db.all('SELECT id FROM accounts WHERE enc_version = 1');
  for (const { id } of legacy) {
    const bound = accountCipher(cipher, id);
    const move = (blob, purpose) => (blob == null ? null : bound.encryptJson(cipher.decryptJson(blob, purpose), purpose));
    try {
      await db.transaction(async (tx) => {
        const account = await tx.get('SELECT auth_key_enc FROM accounts WHERE id = $1', [id]);
        await tx.run('UPDATE accounts SET auth_key_enc = $1, enc_version = 2 WHERE id = $2', [move(account.auth_key_enc, 'authkey'), id]);
        for (const table of ['profiles', 'backups']) {
          const rows = await tx.all(`SELECT id, library_enc, addons_enc, notifs_enc FROM ${table} WHERE account_id = $1`, [id]);
          for (const row of rows) {
            await tx.run(`UPDATE ${table} SET library_enc = $1, addons_enc = $2, notifs_enc = $3 WHERE id = $4`,
              [move(row.library_enc, 'library'), move(row.addons_enc, 'addons'), move(row.notifs_enc, 'notifs'), row.id]);
          }
        }
      });
      log?.info('Upgraded stored data to per-account encryption', { accountId: id });
    } catch (err) {
      log?.error('Could not upgrade stored data for an account; it was left unchanged', { accountId: id, error: err.message });
      throw err;
    }
  }
}
