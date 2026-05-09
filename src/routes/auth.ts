import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { body, validationResult } from 'express-validator';
import { rateLimit } from 'express-rate-limit';
import { prisma } from '../utils/prisma';
import { signAccessToken, signRefreshToken, verifyRefreshToken, signPasswordResetToken, verifyPasswordResetToken } from '../utils/jwt';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { emailService } from '../services/email';
import { applyReferralCode } from './referral';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts, please try again in 15 minutes.' },
});

// ─── Generate unique referral code ───────────────────────────────────────────
function generateReferralCode(name: string): string {
  const base = name.replace(/\s+/g, '').substring(0, 5).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${base}${rand}`; // e.g. "RAHUL9KX2A"
}

async function getUniqueReferralCode(name: string): Promise<string> {
  let code = generateReferralCode(name);
  // Ensure uniqueness
  while (await prisma.user.findUnique({ where: { referralCode: code } })) {
    code = generateReferralCode(name);
  }
  return code;
}

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
router.post('/signup',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('name').trim().notEmpty().withMessage('Name is required'),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // ref = referral code from query string or body (?ref=RAHUL9KX2A)
    const { email, password, name, ref } = req.body;

    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: 'Email already in use' });
      }

      const hashed = await bcrypt.hash(password, 12);
      const trialEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days base
      const referralCode = await getUniqueReferralCode(name);

      const user = await prisma.user.create({
        data: {
          email,
          password: hashed,
          name,
          trialEndsAt,
          referralCode, // ← assign unique code on creation
          aiSettings: {
            create: {
              goal: 'engagement',
              tone: 'friendly',
            },
          },
        },
        select: { id: true, email: true, name: true, trialEndsAt: true, referralCode: true },
      });

      // Apply referral bonus if user came via a referral link
      if (ref && typeof ref === 'string') {
        await applyReferralCode(user.id, ref.trim().toUpperCase());
      }

      const accessToken = signAccessToken({ userId: user.id, email: user.email });
      const refreshToken = signRefreshToken({ userId: user.id, email: user.email });

      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      await emailService.sendWelcome(user.email, user.name || 'there');

      res.status(201).json({
        user,
        accessToken,
        message: 'Account created! Your 3-day free trial has started.',
      });
    } catch (error) {
      logger.error('Signup error:', error);
      res.status(500).json({ error: 'Failed to create account' });
    }
  }
);

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    try {
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true, email: true, name: true, password: true,
          trialEndsAt: true, isTrialActive: true, subStatus: true, avatar: true,
        },
      });

      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const now = new Date();
      if (user.isTrialActive && new Date(user.trialEndsAt) < now) {
        await prisma.user.update({
          where: { id: user.id },
          data: { isTrialActive: false },
        });
        user.isTrialActive = false;
      }

      const accessToken = signAccessToken({ userId: user.id, email: user.email });
      const refreshToken = signRefreshToken({ userId: user.id, email: user.email });

      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      const { password: _, ...safeUser } = user;
      res.json({ user: safeUser, accessToken });
    } catch (error) {
      logger.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// ─── POST /api/auth/refresh ───────────────────────────────────────────────────
router.post('/refresh', async (req: Request, res: Response) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  try {
    const payload = verifyRefreshToken(token);
    const accessToken = signAccessToken({ userId: payload.userId, email: payload.email });
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('refresh_token');
  res.json({ message: 'Logged out successfully' });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true, email: true, name: true, avatar: true,
        trialEndsAt: true, isTrialActive: true,
        subStatus: true, subPlan: true, stripeCustomerId: true,
        createdAt: true,
        referralCode: true,   // ← expose for frontend
        referralCredits: true,
        instagramAccount: {
          select: {
            id: true, username: true, isActive: true,
            automationOn: true, followerCount: true, profilePicUrl: true,
          },
        },
        aiSettings: true,
      },
    });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────
router.post('/forgot-password',
  authLimiter,
  [body('email').isEmail().normalizeEmail()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email } = req.body;

    try {
      const user = await prisma.user.findUnique({ where: { email } });

      if (user) {
        const token = signPasswordResetToken(user.id);
        const expiry = new Date(Date.now() + 60 * 60 * 1000);

        await prisma.user.update({
          where: { id: user.id },
          data: { resetToken: token, resetTokenExpiry: expiry },
        });

        const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
        await emailService.sendPasswordReset(email, resetUrl);
      }

      res.json({ message: 'If that email exists, a reset link has been sent.' });
    } catch (error) {
      logger.error('Forgot password error:', error);
      res.status(500).json({ error: 'Failed to process request' });
    }
  }
);

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
router.post('/reset-password',
  authLimiter,
  [
    body('token').notEmpty(),
    body('password').isLength({ min: 8 }),
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { token, password } = req.body;

    try {
      const { userId } = verifyPasswordResetToken(token);

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, resetToken: true, resetTokenExpiry: true },
      });

      if (!user || user.resetToken !== token) {
        return res.status(400).json({ error: 'Invalid or expired reset token' });
      }

      if (!user.resetTokenExpiry || new Date(user.resetTokenExpiry) < new Date()) {
        return res.status(400).json({ error: 'Reset token has expired' });
      }

      const hashed = await bcrypt.hash(password, 12);
      await prisma.user.update({
        where: { id: userId },
        data: { password: hashed, resetToken: null, resetTokenExpiry: null },
      });

      res.json({ message: 'Password reset successfully' });
    } catch (error) {
      res.status(400).json({ error: 'Invalid or expired token' });
    }
  }
);

export default router;
