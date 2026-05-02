import { Router, Response, Request } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { InstagramService } from '../services/instagram';
import { decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

const router = Router();

// ─── GET all keyword rules ────────────────────────────────────────────────────
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const rules = await prisma.keywordRule.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ mediaId: 'asc' }, { createdAt: 'desc' }],
    });

    // Group by mediaId
    const grouped = rules.reduce((acc: any, rule) => {
      const key = rule.mediaId || 'global';
      if (!acc[key]) acc[key] = [];
      acc[key].push(rule);
      return acc;
    }, {});

    res.json(grouped);
  } catch (err) {
    logger.error('Error fetching keyword rules:', err);
    res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

// ─── GET user's Instagram posts ───────────────────────────────────────────────
router.get('/my-posts', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const account = await prisma.instagramAccount.findUnique({
      where: { userId: req.user!.id },
    });

    if (!account?.accessToken) {
      return res.status(404).json({ error: 'No Instagram connected' });
    }

    const token = account.pageToken
      ? decrypt(account.pageToken)
      : decrypt(account.accessToken);

    const igService = new InstagramService(token, account.igUserId);
    const media = await igService.getUserMedia(20);

    res.json(media);
  } catch (err) {
    logger.error('Error fetching posts:', err);
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ─── CREATE keyword rule ──────────────────────────────────────────────────────
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const {
      keyword, replyText, source, matchType,
      mediaId, mediaUrl, mediaCaption, autoDM, dmReplyText
    } = req.body;

    if (!keyword || !replyText) {
      return res.status(400).json({ error: 'keyword and replyText are required' });
    }

    if (autoDM && !dmReplyText) {
      return res.status(400).json({ error: 'dmReplyText required when autoDM is enabled' });
    }

    const rule = await prisma.keywordRule.create({
      data: {
        userId: req.user!.id,
        keyword: keyword.toLowerCase().trim(),
        replyText: replyText.trim(),
        source: source || 'both',
        matchType: matchType || 'contains',
        mediaId: mediaId || null,
        mediaUrl: mediaUrl || null,
        mediaCaption: mediaCaption || null,
        autoDM: autoDM || false,
        dmReplyText: dmReplyText?.trim() || null,
      },
    });

    logger.info(`Keyword rule created for user ${req.user!.id}: "${keyword}"`);
    res.json(rule);
  } catch (err) {
    logger.error('Error creating keyword rule:', err);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

// ─── UPDATE keyword rule ──────────────────────────────────────────────────────
router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const {
      keyword, replyText, source, matchType,
      mediaId, mediaCaption, autoDM, dmReplyText
    } = req.body;

    await prisma.keywordRule.updateMany({
      where: { id: req.params.id, userId: req.user!.id },
      data: {
        keyword: keyword?.toLowerCase().trim(),
        replyText: replyText?.trim(),
        source,
        matchType,
        mediaId: mediaId || null,
        mediaCaption: mediaCaption || null,
        autoDM: autoDM || false,
        dmReplyText: dmReplyText?.trim() || null,
      },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('Error updating keyword rule:', err);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

// ─── TOGGLE active/inactive ───────────────────────────────────────────────────
router.patch('/:id/toggle', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const rule = await prisma.keywordRule.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });

    if (!rule) {
      return res.status(404).json({ error: 'Rule not found' });
    }

    await prisma.keywordRule.update({
      where: { id: req.params.id },
      data: { isActive: !rule.isActive },
    });

    res.json({ isActive: !rule.isActive });
  } catch (err) {
    logger.error('Error toggling keyword rule:', err);
    res.status(500).json({ error: 'Failed to toggle rule' });
  }
});

// ─── DELETE keyword rule ──────────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    await prisma.keywordRule.deleteMany({
      where: { id: req.params.id, userId: req.user!.id },
    });

    res.json({ message: 'Deleted' });
  } catch (err) {
    logger.error('Error deleting keyword rule:', err);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

export default router;
