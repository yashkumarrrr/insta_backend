import CryptoJS from 'crypto-js';

const SECRET = process.env.ENCRYPTION_KEY || 'fallback-secret-change-in-production';

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
