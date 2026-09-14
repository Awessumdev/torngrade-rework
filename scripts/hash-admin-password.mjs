import { hashPassword } from '../src/auth/passwords.mjs';

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-admin-password.mjs <password>');
  process.exit(1);
}

console.log(hashPassword(password));
