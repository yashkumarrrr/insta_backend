import { Router, Response, Request } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { emailService } from '../services/email';

const router = Router();
router.use(authenticate);

// ─── How the referral system works ───────────────────────────────────────────
// 1. Every user gets a unique referral code on signup (stored on User model)
// 2. New user signs up with ?ref=CODE → they get +7 days trial bonus
// 3. Referrer gets +7 days trial added (or future: credit/discount)
// 4. ReferralEvent tracks every referral with status: pending → converted
// 5. Converted = referred user subscribes (paid) — referrer gets reward
// ─────────────────────────────────────────────────────────────────────────────

// ─── GET /api/referral/me ─────────────────────────────────────────────────────
// Returns the current user's referral code, link, stats
router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        referralCode: true,
        referralCredits: true,
        referredBy: true,
      },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Count referrals
    const [totalReferred, converted, pending] = await Promise.all([
      prisma.referralEvent.count({ where: { referrerId: userId } }),
      prisma.referralEvent.count({ where: { referrerId: userId, status: 'converted' } }),
      prisma.referralEvent.count({ where: { referrerId: userId, status: 'pending' } }),
    ]);

    // Get recent referral events
    const recentReferrals = await prisma.referralEvent.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        status: true,
        rewardDays: true,
        createdAt: true,
        convertedAt: true,
        referred: {
          select: { name: true, email: true, createdAt: true },
        },
      },
    });

    const referralLink = `${process.env.FRONTEND_URL}/auth/signup?ref=${user.referralCode}`;

    res.json({
      referralCode: user.referralCode,
      referralLink,
      referralCredits: user.referralCredits, // total bonus days earned
      stats: {
        totalReferred,
        converted,
        pending,
      },
      recentReferrals,
    });
  } catch (err: any) {
    logger.error('Failed to get referral info', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/referral/leaderboard ───────────────────────────────────────────
// Top referrers — motivates users to refer more
router.get('/leaderboard', async (req: AuthRequest, res: Response) => {
  try {
    const top = await prisma.referralEvent.groupBy({
      by: ['referrerId'],
      _count: { referrerId: true },
      where: { status: 'converted' },
      orderBy: { _count: { referrerId: 'desc' } },
      take: 10,
    });

    const enriched = await Promise.all(
      top.map(async (entry) => {
        const user = await prisma.user.findUnique({
          where: { id: entry.referrerId },
          select: { name: true },
        });
        return {
          name: user?.name ? user.name.split(' ')[0] + ' ' + (user.name.split(' ')[1]?.[0] || '') + '.' : 'Anonymous',
          conversions: entry._count.referrerId,
        };
      })
    );

    res.json(enriched);
  } catch (err: any) {
    logger.error('Leaderboard error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/referral/send-invite ──────────────────────────────────────────
// User enters friend's email — we send them an invite email
router.post('/send-invite', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { email } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    // Don't invite someone already signed up
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'This email is already registered' });
    }

    const referrer = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, referralCode: true },
    });

    if (!referrer) return res.status(404).json({ error: 'User not found' });

    const referralLink = `${process.env.FRONTEND_URL}/auth/signup?ref=${referrer.referralCode}`;

    await emailService.sendReferralInvite(email, referrer.name || 'Someone', referralLink);

    logger.info('Referral invite sent', { from: userId, to: email });
    res.json({ success: true, message: `Invite sent to ${email}` });
  } catch (err: any) {
    logger.error('Send invite error', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

// ─── EXPORTED HELPERS (used in auth.ts signup + billing webhook) ─────────────

// Called during signup when ?ref=CODE is present
export async function applyReferralCode(newUserId: string, referralCode: string) {
  try {
    // Find referrer by code
    const referrer = await prisma.user.findUnique({
      where: { referralCode },
      select: { id: true, name: true, email: true, trialEndsAt: true, isTrialActive: true },
    });

    if (!referrer || referrer.id === newUserId) return; // invalid or self-referral

    // Create the referral event
    await prisma.referralEvent.create({
      data: {
        referrerId: referrer.id,
        referredId: newUserId,
        status: 'pending',
        rewardDays: 7, // referrer gets 7 days when referred user converts
      },
    });

    // Give the NEW user an immediate +7 day trial bonus
    const newUser = await prisma.user.findUnique({
      where: { id: newUserId },
      select: { trialEndsAt: true },
    });

    if (newUser) {
      const bonusTrial = new Date(newUser.trialEndsAt);
      bonusTrial.setDate(bonusTrial.getDate() + 7);
      await prisma.user.update({
        where: { id: newUserId },
        data: {
          trialEndsAt: bonusTrial,
          referredBy: referralCode,
        },
      });
    }

    // Notify referrer
    await emailService.sendReferralPending(
      referrer.email,
      referrer.name || 'there',
    );

    logger.info('Referral applied', { referrerId: referrer.id, newUserId });
  } catch (err) {
    // Non-critical — don't break signup if referral fails
    logger.error('applyReferralCode failed', err);
  }
}

// Called from billing webhook when referred user's payment succeeds
export async function convertReferral(paidUserId: string) {
  try {
    const event = await prisma.referralEvent.findFirst({
      where: { referredId: paidUserId, status: 'pending' },
      include: {
        referrer: { select: { id: true, email: true, name: true, trialEndsAt: true, isTrialActive: true } },
      },
    });

    if (!event) return;

    // Mark as converted
    await prisma.referralEvent.update({
      where: { id: event.id },
      data: { status: 'converted', convertedAt: new Date() },
    });

    // Give referrer their reward: +7 days trial OR extend subscription
    const referrer = event.referrer;
    const bonusDays = event.rewardDays;

    // Extend trial or add credit days
    const currentExpiry = new Date(referrer.trialEndsAt);
    const newExpiry = new Date(Math.max(currentExpiry.getTime(), Date.now()));
    newExpiry.setDate(newExpiry.getDate() + bonusDays);

    await prisma.user.update({
      where: { id: referrer.id },
      data: {
        trialEndsAt: newExpiry,
        isTrialActive: true,
        referralCredits: { increment: bonusDays },
      },
    });

    // Notify referrer of reward
    await emailService.sendReferralConverted(
      referrer.email,
      referrer.name || 'there',
      bonusDays,
    );

    logger.info('Referral converted — reward granted', {
      referrerId: referrer.id,
      bonusDays,
    });
  } catch (err) {
    logger.error('convertReferral failed', err);
  }
}
