import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';

const router = Router();
router.use(authenticate);

router.get('/overview', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalConversations,
    totalLeads,
    messagesThisWeek,
    aiRepliesThisWeek,
    automationLogs,
    igAccount,
  ] = await Promise.all([
    prisma.conversation.count({ where: { userId } }),
    prisma.lead.count({ where: { userId } }),
    prisma.message.count({ where: { conversation: { userId }, sentAt: { gte: since } } }),
    prisma.message.count({ where: { conversation: { userId }, senderType: 'ai', sentAt: { gte: since } } }),
    prisma.automationLog.findMany({
      where: { userId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { type: true, status: true, source: true, createdAt: true, error: true },
    }),
    prisma.instagramAccount.findUnique({
      where: { userId },
      select: { automationOn: true, isActive: true, username: true },
    }),
  ]);

  res.json({
    stats: {
      totalConversations,
      totalLeads,
      messagesThisWeek,
      aiRepliesThisWeek,
      successRate: automationLogs.length
        ? Math.round((automationLogs.filter((l: any) => l.status === 'success').length / automationLogs.length) * 100)
        : 100,
    },
    recentActivity: automationLogs,
    automationStatus: igAccount?.automationOn || false,
  });
});

export default router;
