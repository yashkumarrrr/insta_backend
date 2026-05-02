import { Router, Request, Response } from 'express';
import { Webhooks } from '@dodopayments/express';
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
router.post(
  '/dodo',
  Webhooks({
    webhookKey: process.env.DODO_WEBHOOK_SECRET!,

    onPayload: async (payload: any) => {
      logger.info(`💳 Dodo webhook event: ${payload.type}`);
    },

    // Subscription activated
    onSubscriptionActive: async (payload: any) => {
      try {
        const sub = payload.data;
        const userId = sub.metadata?.userId;
        if (!userId) return;

        await prisma.user.update({
          where: { id: userId },
          data: {
            stripeCustomerId: sub.customer_id,
            stripeSubId: sub.subscription_id,
            subStatus: 'active',
            subPlan: 'pro',
            isTrialActive: false,
          },
        });

        await prisma.billingEvent.create({
          data: {
            userId,
            stripeEventId: sub.subscription_id,
            type: 'subscription.active',
            status: 'processed',
          },
        });

        logger.info('✅ Subscription activated for user:', userId);
      } catch (err: any) {
        logger.error('❌ onSubscriptionActive error:', err.message);
      }
    },

    // Subscription cancelled
    onSubscriptionCancelled: async (payload: any) => {
      try {
        const sub = payload.data;
        const userId = sub.metadata?.userId;
        if (!userId) return;

        await prisma.user.update({
          where: { id: userId },
          data: { subStatus: 'cancelled', subPlan: 'free' },
        });

        await prisma.instagramAccount.updateMany({
          where: { userId },
          data: { automationOn: false },
        });

        logger.info('✅ Subscription cancelled for user:', userId);
      } catch (err: any) {
        logger.error('❌ onSubscriptionCancelled error:', err.message);
      }
    },

    // Payment succeeded
    onPaymentSucceeded: async (payload: any) => {
      try {
        const payment = payload.data;
        const userId = payment.metadata?.userId;
        if (!userId) return;

        await prisma.billingEvent.create({
          data: {
            userId,
            stripeEventId: payment.payment_id,
            type: 'payment.succeeded',
            status: 'processed',
            amount: payment.total_amount,
            currency: payment.currency,
          },
        });

        logger.info('✅ Payment succeeded for user:', userId);
      } catch (err: any) {
        logger.error('❌ onPaymentSucceeded error:', err.message);
      }
    },

    // Payment failed
    onPaymentFailed: async (payload: any) => {
      try {
        const payment = payload.data;
        const userId = payment.metadata?.userId;
        if (!userId) return;

        await prisma.user.update({
          where: { id: userId },
          data: { subStatus: 'past_due' },
        });

        logger.info('⚠️ Payment failed for user:', userId);
      } catch (err: any) {
        logger.error('❌ onPaymentFailed error:', err.message);
      }
    },
  })
);

export default router;
