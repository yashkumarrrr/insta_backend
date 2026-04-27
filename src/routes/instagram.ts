import { Router, Response, Request } from 'express';
import { authenticate, requireActiveSubscription, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { InstagramService, exchangeCodeForToken, getLongLivedToken } from '../services/instagram';
import { encrypt, decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const router = Router();

const authRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts. Try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
});

const apiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.id || req.ip || 'unknown',
});

const strictRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many requests for this action.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.id || req.ip || 'unknown',
});

const validStates = new Map<string, { userId: string; expiresAt: number }>();

const generateState = (userId: string): string => {
  const state = crypto.randomBytes(32).toString('hex');
  validStates.set(state, {
    userId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return state;
};

const validateState = (state: string): string | null => {
  const entry = validStates.get(state);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    validStates.delete(state);
    return null;
  }
  validStates.delete(state);
  return entry.userId;
};

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of validStates.entries()) {
    if (now > val.expiresAt) validStates.delete(key);
  }
}, 15 * 60 * 1000);

// ─── GET /api/instagram/auth ──────────────────────────────────────────────────
router.get('/auth', authRateLimit, authenticate, (req: AuthRequest, res: Response) => {
  const redirectUri = `${process.env.BACKEND_URL}/api/instagram/callback`;
  const state = generateState(req.user!.id);
  const scopes = [
    'public_profile',
    'pages_show_list',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_manage_comments',
    'instagram_manage_messages',
  ].join(',');
  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${process.env.META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&response_type=code` +
    `&state=${state}`;
  logger.info(`Instagram OAuth initiated for user ${req.user!.id}`);
  res.redirect(url);
});

// ─── GET /api/instagram/auth-url ─────────────────────────────────────────────
router.get('/auth-url', authRateLimit, authenticate, (req: AuthRequest, res: Response) => {
  const redirectUri = `${process.env.BACKEND_URL}/api/instagram/callback`;
  const state = generateState(req.user!.id);
  const scopes = [
    'public_profile',
    'pages_show_list',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_manage_comments',
    'instagram_manage_messages',
  ].join(',');
  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${process.env.META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${scopes}` +
    `&response_type=code` +
    `&state=${state}`;
  res.json({ url });
});

// ─── GET /api/instagram/callback ─────────────────────────────────────────────
router.get('/callback', authRateLimit, async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    logger.warn(`Instagram OAuth denied: ${error} - ${error_description}`);
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?error=access_denied`);
  }

  if (!code || !state) {
    logger.warn('Instagram callback: missing code or state');
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?error=invalid_request`);
  }

  const userId = validateState(state);
  if (!userId) {
    logger.warn(`Instagram callback: invalid or expired state ${state}`);
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?error=invalid_state`);
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    logger.warn(`Instagram callback: user not found ${userId}`);
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?error=user_not_found`);
  }

  try {
    const redirectUri = `${process.env.BACKEND_URL}/api/instagram/callback`;
    const { access_token: shortToken, user_id } = await exchangeCodeForToken(code, redirectUri);
    const { access_token, expires_in } = await getLongLivedToken(shortToken);

    const igService = new InstagramService(access_token, user_id);
    const accountInfo = await igService.getAccountInfo();

    const tokenExpiry = expires_in ? new Date(Date.now() + expires_in * 1000) : null;

    await prisma.instagramAccount.upsert({
      where: { igUserId: accountInfo.id },
      create: {
        userId,
        igUserId: accountInfo.id,
        username: accountInfo.username,
        accessToken: encrypt(access_token),
        tokenExpiry,
        pageId: accountInfo.page_id,
        pageToken: encrypt(accountInfo.page_access_token),
        profilePicUrl: accountInfo.profile_picture_url ?? null,
        followerCount: accountInfo.followers_count ?? null,
        isActive: true,
      },
      update: {
        igUserId: accountInfo.id,
        username: accountInfo.username,
        accessToken: encrypt(access_token),
        tokenExpiry,
        pageId: accountInfo.page_id,
        pageToken: encrypt(accountInfo.page_access_token),
        profilePicUrl: accountInfo.profile_picture_url ?? null,
        followerCount: accountInfo.followers_count ?? null,
        isActive: true,
      },
    });

    // ✅ Auto-subscribe webhook on connect
    try {
      await igService.subscribeToWebhooks(accountInfo.page_id, accountInfo.page_access_token);
      logger.info(`✅ Webhook subscribed for page ${accountInfo.page_id}`);
    } catch (err) {
      logger.error('Failed to subscribe webhook on connect:', err);
    }

    logger.info(`Instagram connected for user ${userId} (@${accountInfo.username}) igId=${accountInfo.id}`);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?success=true`);
  } catch (err) {
    logger.error('Instagram OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?error=auth_failed`);
  }
});

// ─── GET /api/instagram/status ────────────────────────────────────────────────
router.get('/status', apiRateLimit, authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const account = await prisma.instagramAccount.findUnique({
      where: { userId: req.user!.id },
      select: {
        id: true,
        username: true,
        isActive: true,
        automationOn: true,
        followerCount: true,
        profilePicUrl: true,
        connectedAt: true,
        webhookVerified: true,
      },
    });
    res.json({ connected: !!account, account });
  } catch (err) {
    logger.error('Error fetching status:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// ─── POST /api/instagram/toggle-automation ────────────────────────────────────
router.post(
  '/toggle-automation',
  strictRateLimit,
  authenticate,
  requireActiveSubscription,
  async (req: AuthRequest, res: Response) => {
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    try {
      const account = await prisma.instagramAccount.findUnique({
        where: { userId: req.user!.id },
      });

      if (!account) {
        return res.status(404).json({ error: 'No Instagram account connected' });
      }

      const updated = await prisma.instagramAccount.update({
        where: { userId: req.user!.id },
        data: { automationOn: enabled },
      });

      logger.info(`Automation ${enabled ? 'ON' : 'OFF'} for user ${req.user!.id}`);

      // Auto-subscribe webhook when turning automation ON
      if (enabled && account.pageId && account.pageToken) {
        try {
          const pageToken = decrypt(account.pageToken);
          const igService = new InstagramService(decrypt(account.accessToken), account.igUserId);
          await igService.subscribeToWebhooks(account.pageId, pageToken);
          logger.info(`✅ Webhook subscribed for page ${account.pageId}`);
        } catch (err) {
          logger.error('Failed to subscribe webhook:', err);
        }
      }

      res.json({ automationOn: updated.automationOn });
    } catch (err) {
      logger.error('Error toggling automation:', err);
      res.status(500).json({ error: 'Failed to toggle automation' });
    }
  }
);

// ─── DELETE /api/instagram/disconnect ────────────────────────────────────────
router.delete('/disconnect', strictRateLimit, authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.instagramAccount.deleteMany({
      where: { userId: req.user!.id },
    });
    logger.info(`Instagram disconnected for user ${req.user!.id}`);
    res.json({ message: 'Instagram account disconnected' });
  } catch (err) {
    logger.error('Error disconnecting:', err);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// ─── GET /api/instagram/media ─────────────────────────────────────────────────
router.get(
  '/media',
  apiRateLimit,
  authenticate,
  requireActiveSubscription,
  async (req: AuthRequest, res: Response) => {
    try {
      const account = await prisma.instagramAccount.findUnique({
        where: { userId: req.user!.id },
      });

      if (!account?.accessToken) {
        return res.status(404).json({ error: 'No Instagram account connected' });
      }

      if (account.tokenExpiry && new Date() > account.tokenExpiry) {
        return res.status(401).json({ error: 'Token expired. Please reconnect Instagram.' });
      }

      const token = decrypt(account.accessToken);
      const igService = new InstagramService(token, account.igUserId);
      const media = await igService.getUserMedia(10);
      res.json(media);
    } catch (err) {
      logger.error('Error fetching media:', err);
      res.status(500).json({ error: 'Failed to fetch media' });
    }
  }
);

export default router;
