import { Router, Request, Response } from 'express';
import { prisma } from '../utils/prisma';
import { authenticate } from '../middleware/auth';
import { InstagramService } from '../services/instagram';
import { decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

// GET /api/reel-context — get all reel contexts + fetch latest reels
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    const [reelContexts, igAccount] = await Promise.all([
      prisma.reelContext.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.instagramAccount.findUnique({ where: { userId } }),
    ]);

    if (!igAccount) return res.json({ reels: [], contexts: reelContexts });

    // Fetch latest reels from Instagram
    const token = igAccount.pageToken
      ? decrypt(igAccount.pageToken)
      : decrypt(igAccount.accessToken);

    const igService = new InstagramService(token, igAccount.igUserId, igAccount.pageId);
    const reels = await igService.getUserMedia(20);

    res.json({ reels, contexts: reelContexts });
  } catch (err: any) {
    logger.error('Failed to get reel contexts', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/reel-context/:mediaId — save or update context for a reel
router.put('/:mediaId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { mediaId } = req.params;
    const { customContext, aiGoal, aiTone, caption, thumbnailUrl, permalink } = req.body;

    const context = await prisma.reelContext.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: {
        userId,
        mediaId,
        customContext: customContext || null,
        aiGoal: aiGoal || null,
        aiTone: aiTone || null,
        caption: caption || null,
        thumbnailUrl: thumbnailUrl || null,
        permalink: permalink || null,
      },
      update: {
        customContext: customContext || null,
        aiGoal: aiGoal || null,
        aiTone: aiTone || null,
        updatedAt: new Date(),
      },
    });

    res.json(context);
  } catch (err: any) {
    logger.error('Failed to save reel context', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reel-context/:mediaId — remove custom context
router.delete('/:mediaId', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { mediaId } = req.params;
    await prisma.reelContext.delete({
      where: { userId_mediaId: { userId, mediaId } },
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
