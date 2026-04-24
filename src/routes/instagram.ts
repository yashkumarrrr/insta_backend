import { Router, Response } from 'express';
import { authenticate, requireActiveSubscription, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { InstagramService, exchangeCodeForToken, getLongLivedToken } from '../services/instagram';
import { encrypt, decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

const router = Router();

router.use(authenticate);

// ─── GET /api/instagram/auth-url ──────────────────────────────────────────────
router.get('/auth-url', (req: AuthRequest, res: Response) => {
  const redirectUri = `${process.env.BACKEND_URL}/api/instagram/callback`;
  const scopes = [
  'public_profile',
  'pages_show_list',
  'business_management',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'pages_manage_metadata'
].join(' ');;

  const url = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.META_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&response_type=code&state=${req.user!.id}`;

  res.json({ url });
});

// ─── GET /api/instagram/callback ─────────────────────────────────────────────
router.get('/callback', async (req: AuthRequest, res: Response) => {
  const { code, state: userId, error } = req.query as Record<string, string>;

  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?error=access_denied`);
  }

  try {
    const redirectUri = `${process.env.BACKEND_URL}/api/instagram/callback`;
    const { access_token: shortToken, user_id } = await exchangeCodeForToken(code, redirectUri);
    const { access_token, expires_in } = await getLongLivedToken(shortToken);

    const igService = new InstagramService(access_token, user_id);
    const accountInfo = await igService.getAccountInfo();

    const tokenExpiry = new Date(Date.now() + expires_in * 1000);

    await prisma.instagramAccount.upsert({
      where: { userId },
      create: {
        userId,
        igUserId: user_id,
        username: accountInfo.username,
        accessToken: encrypt(access_token),
        tokenExpiry,
        profilePicUrl: accountInfo.profile_picture_url,
        followerCount: accountInfo.followers_count,
        isActive: true,
      },
      update: {
        igUserId: user_id,
        username: accountInfo.username,
        accessToken: encrypt(access_token),
        tokenExpiry,
        profilePicUrl: accountInfo.profile_picture_url,
        followerCount: accountInfo.followers_count,
        isActive: true,
      },
    });

    res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?success=true`);
  } catch (err) {
    logger.error('Instagram OAuth error:', err);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard/instagram?error=auth_failed`);
  }
});

// ─── GET /api/instagram/status ────────────────────────────────────────────────
router.get('/status', async (req: AuthRequest, res: Response) => {
  const account = await prisma.instagramAccount.findUnique({
    where: { userId: req.user!.id },
    select: {
      id: true, username: true, isActive: true, automationOn: true,
      followerCount: true, profilePicUrl: true, connectedAt: true,
      webhookVerified: true,
    },
  });
  res.json({ connected: !!account, account });
});

// ─── POST /api/instagram/toggle-automation ────────────────────────────────────
router.post('/toggle-automation', requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  const { enabled } = req.body;

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

  logger.info(`Automation ${enabled ? 'enabled' : 'disabled'} for user ${req.user!.id}`);
  res.json({ automationOn: updated.automationOn });
});

// ─── DELETE /api/instagram/disconnect ────────────────────────────────────────
router.delete('/disconnect', async (req: AuthRequest, res: Response) => {
  await prisma.instagramAccount.deleteMany({
    where: { userId: req.user!.id },
  });
  res.json({ message: 'Instagram account disconnected' });
});

// ─── GET /api/instagram/media ─────────────────────────────────────────────────
router.get('/media', requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  const account = await prisma.instagramAccount.findUnique({
    where: { userId: req.user!.id },
  });

  if (!account?.accessToken) {
    return res.status(404).json({ error: 'No Instagram account connected' });
  }

  try {
    const token = decrypt(account.accessToken);
    const igService = new InstagramService(token, account.igUserId);
    const media = await igService.getUserMedia(10);
    res.json(media);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch media' });
  }
});

export default router;
