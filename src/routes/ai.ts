import { Router, Response } from 'express';
import { authenticate, requireActiveSubscription, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';

const router = Router();
router.use(authenticate);

router.get('/settings', async (req: AuthRequest, res: Response) => {
  const settings = await prisma.aISettings.findUnique({ where: { userId: req.user!.id } });
  res.json(settings);
});

router.put('/settings', async (req: AuthRequest, res: Response) => {
  const {
    businessName, businessDescription, productDetails, targetAudience,
    goal, tone, customInstructions, replyToDMs, replyToComments,
    autoSendDMs, maxDMsPerHour, maxRepliesPerHour,
  } = req.body;
  const settings = await prisma.aISettings.upsert({
    where: { userId: req.user!.id },
    create: {
      userId: req.user!.id,
      businessName, businessDescription, productDetails, targetAudience,
      goal: goal || 'engagement', tone: tone || 'friendly',
      customInstructions, replyToDMs, replyToComments,
      autoSendDMs, maxDMsPerHour, maxRepliesPerHour,
    },
    update: {
      businessName, businessDescription, productDetails, targetAudience,
      goal, tone, customInstructions, replyToDMs, replyToComments,
      autoSendDMs, maxDMsPerHour, maxRepliesPerHour,
    },
  });
  res.json(settings);
});

router.post('/test-reply', requireActiveSubscription, async (req: AuthRequest, res: Response) => {
  const { message } = req.body;
  const settings = await prisma.aISettings.findUnique({ where: { userId: req.user!.id } });
  const { generateAIReply } = await import('../services/openai');
  const reply = await generateAIReply(
    {
      businessName: settings?.businessName || undefined,
      businessDescription: settings?.businessDescription || undefined,
      productDetails: settings?.productDetails || undefined,
      targetAudience: settings?.targetAudience || undefined,
      goal: settings?.goal || 'engagement',
      tone: settings?.tone || 'friendly',
      customInstructions: settings?.customInstructions || undefined,
    },
    { incomingMessage: message, source: 'dm', igUsername: 'test_user' }
  );
  res.json({ reply });
});

export default router;
