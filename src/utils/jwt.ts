import jwt from 'jsonwebtoken';

if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error('JWT secrets must be set in environment variables');
}

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET!;

export interface JWTPayload {
  userId: string;
  email: string;
}

export function signAccessToken(payload: JWTPayload): string {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: '15m' });
}

export function signRefreshToken(payload: JWTPayload): string {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d' });
}

export function verifyAccessToken(token: string): JWTPayload {
  return jwt.verify(token, ACCESS_SECRET) as JWTPayload;
}

export function verifyRefreshToken(token: string): JWTPayload {
  return jwt.verify(token, REFRESH_SECRET) as JWTPayload;
}

export function signPasswordResetToken(userId: string): string {
  return jwt.sign({ userId, type: 'password_reset' }, ACCESS_SECRET, { expiresIn: '1h' });
}

export function verifyPasswordResetToken(token: string): { userId: string } {
  const payload = jwt.verify(token, ACCESS_SECRET) as any;
  if (payload.type !== 'password_reset') throw new Error('Invalid token type');
  return { userId: payload.userId };
}
