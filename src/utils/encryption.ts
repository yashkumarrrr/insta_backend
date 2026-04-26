import CryptoJS from 'crypto-js';

if (!process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY environment variable is required');
}
const SECRET = process.env.ENCRYPTION_KEY;

export function encrypt(text: string): string {
  return CryptoJS.AES.encrypt(text, SECRET).toString();
}

export function decrypt(ciphertext: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET);
  return bytes.toString(CryptoJS.enc.Utf8);
}

export function hashToken(token: string): string {
  return CryptoJS.SHA256(token).toString();
}
