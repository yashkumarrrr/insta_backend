import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';
import { automationQueue } from '../workers/automationQueue';

const router = Router();

// ─────────────────────────────────────────────
// ✅ INSTAGRAM WEBHOOK VERIFY (GET)
// ─────────────────────────────────────────────
router.get('/instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    token === process.env.META_WEBHOOK_VERIFY_TOKEN
  ) {
    logger.info('✅ Instagram webhook verified');
    return res.status(200).send(challenge);
  }

  logger.warn('❌ Instagram webhook verification failed');
  return res.status(403).json({ error: 'Forbidden' });
});

// ─────────────────────────────────────────────
// ✅ INSTAGRAM WEBHOOK EVENTS (POST)
// ─────────────────────────────────────────────
router.post('/instagram', async (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;

    if (!body || body.object !== 'instagram') {
      return;
    }

    for (const entry of body.entry || []) {
      const igId = entry.id;

      logger.info(`🔥 Instagram webhook IG ID: ${igId}`);

      const igAccount = await prisma.instagramAccount.findFirst({
        where: {
          igUserId: igId,
          automationOn: true,
          isActive: true,
        },
        include: {
          user: {
            include: {
              aiSettings: true,
            },
          },
        },
      });

      if (!igAccount) {
        logger.warn(`❌ No IG account matched for ID: ${igId}`);
        continue;
      }

      logger.info(`✅ IG account found: ${igAccount.id}`);
      logger.info(`📦 Raw entry: ${JSON.stringify(entry).substring(0, 800)}`);

      logger.info(`📋 Changes count: ${entry.changes?.length || 0}`);
      logger.info(`📋 Messaging count: ${entry.messaging?.length || 0}`);
      for (const change of entry.changes || []) {
        logger.info(`📋 Change field: "${change.field}", verb: "${change.value?.verb}"`);
      }

      if (!igAccount.webhookVerified) {
        await prisma.instagramAccount.update({
          where: { id: igAccount.id },
          data: { webhookVerified: true },
        });
      }

      // ─────────────────────────────
      // 📩 MESSAGES (DM)
      // ─────────────────────────────
      for (const messaging of entry.messaging || []) {
        if (messaging.message_edit) continue;
        if (messaging.read) continue;
        if (messaging.reaction) continue;

        if (messaging.message && !messaging.message.is_echo) {
          await automationQueue.add('process-dm', {
            userId: igAccount.userId,
            igAccountId: igAccount.id,
            senderId: messaging.sender.id,
            message: messaging.message.text || '',
            messageId: messaging.message.mid,
            timestamp: messaging.timestamp,
          });

          logger.info(`📩 DM queued for user ${igAccount.userId}`);
        }
      }

      // ─────────────────────────────
      // 💬 COMMENTS
      // ─────────────────────────────
      for (const change of entry.changes || []) {
        if (change.field === 'comments' || change.field === 'feed') {
          await automationQueue.add('process-comment', {
            userId: igAccount.userId,
            igAccountId: igAccount.id,
            commentId: change.value.id,
            commentText: change.value.text,
            senderId: change.value.from?.id,
            senderName: change.value.from?.name,
            mediaId: change.value.media?.id,
            timestamp: change.value.created_time,
          });

          logger.info(`💬 Comment queued for user ${igAccount.userId}`);
        }
      }
    }
  } catch (err) {
    logger.error('❌ Instagram webhook error:', err);
  }
});

// ─────────────────────────────────────────────
// 💳 DODO PAYMENTS WEBHOOK
// ─────────────────────────────────────────────
router.post('/dodo', async (req: Request, res: Response) => {
  const webhookSecret = process.env.DODO_WEBHOOK_SECRET!;
  const signature = req.headers['webhook-signature'] as string;

  try {
    const hmac = crypto.createHmac('sha256', webhookSecret);
    hmac.update(JSON.stringify(req.body));
    const digest = hmac.digest('hex');

    if (signature && signature !== digest) {
      logger.warn('❌ Dodo webhook signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    logger.error('❌ Dodo signature verification failed:', err);
    return res.status(400).json({ error: 'Signature verification failed' });
  }

  const { type, data } = req.body;
  logger.info(`💳 Dodo webhook event: ${type}`);

  try {
    const userId = data?.metadata?.userId;

    if (type === 'subscription.active' && userId) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          stripeCustomerId: data.customer_id,
          stripeSubId: data.subscription_id,
          subStatus: 'active',
          subPlan: 'pro',
          isTrialActive: false,
        },
      });

      await prisma.billingEvent.create({
        data: {
          userId,
          stripeEventId: data.subscription_id,
          type: 'subscription.active',
          status: 'processed',
        },
      });

      logger.info('✅ Subscription activated for user:', userId);
    }

    if (type === 'subscription.cancelled' && userId) {
      await prisma.user.update({
        where: { id: userId },
        data: { subStatus: 'cancelled', subPlan: 'free' },
      });

      await prisma.instagramAccount.updateMany({
        where: { userId },
        data: { automationOn: false },
      });

      logger.info('✅ Subscription cancelled for user:', userId);
    }

    if (type === 'payment.succeeded' && userId) {
      await prisma.billingEvent.create({
        data: {
          userId,
          stripeEventId: data.payment_id,
          type: 'payment.succeeded',
          status: 'processed',
          amount: data.total_amount,
          currency: data.currency,
        },
      });

      logger.info('✅ Payment succeeded for user:', userId);
    }

    if (type === 'payment.failed' && userId) {
      await prisma.user.update({
        where: { id: userId },
        data: { subStatus: 'past_due' },
      });

      logger.info('⚠️ Payment failed for user:', userId);
    }
  } catch (err: any) {
    logger.error('❌ Dodo webhook processing error:', err.message);
  }

  res.json({ received: true });
});

export default router;
