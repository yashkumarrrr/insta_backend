import { Router, Response } from 'express';
import { authenticate, requireActiveSubscription, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  const { page = '1', limit = '20', status, search } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where: any = { userId: req.user!.id };
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { igUsername: { contains: search, mode: 'insensitive' } },
      { messages: { some: { content: { contains: search, mode: 'insensitive' } } } },
    ];
  }
  const [conversations, total] = await Promise.all([
    prisma.conversation.findMany({
      where, orderBy: { lastMessageAt: 'desc' }, skip, take: parseInt(limit),
      include: { messages: { orderBy: { sentAt: 'desc' }, take: 1, select: { content: true, sentAt: true, direction: true, senderType: true } } },
    }),
    prisma.conversation.count({ where }),
  ]);
  res.json({ conversations, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  const conversation = await prisma.conversation.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: { messages: { orderBy: { sentAt: 'asc' } } },
  });
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json(conversation);
});

router.post('/:id/send', requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  const { message } = req.body;
  const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  const igAccount = await prisma.instagramAccount.findUnique({ where: { userId: req.user!.id } });
  if (!igAccount) return res.status(400).json({ error: 'No Instagram account' });
  try {
    const { InstagramService } = await import('../services/instagram');
    const { decrypt } = await import('../utils/encryption');
    const igService = new InstagramService(decrypt(igAccount.accessToken), igAccount.igUserId);
    await igService.sendDM(conversation.igUserId, message);
    const msg = await prisma.message.create({
      data: { conversationId: conversation.id, direction: 'outbound', senderType: 'human', content: message, deliveredAt: new Date() },
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { messageCount: { increment: 1 }, lastMessageAt: new Date() } });
    res.json(msg);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const { automationOn, status } = req.body;
  const conversation = await prisma.conversation.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!conversation) return res.status(404).json({ error: 'Not found' });
  const updated = await prisma.conversation.update({
    where: { id: req.params.id },
    data: { ...(automationOn !== undefined && { automationOn }), ...(status && { status }) },
  });
  res.json(updated);
});

export default router;
