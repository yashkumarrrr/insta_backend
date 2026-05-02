import { Router, Response, Request } from 'express';
import DodoPayments from 'dodopayments';
import { authenticate, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import { logger } from '../utils/logger';

const router = Router();

const dodo = new DodoPayments({
  bearerToken: process.env.DODO_API_KEY!,
  environment: (process.env.DODO_ENVIRONMENT as 'live_mode' | 'test_mode') || 'live_mode',
});

const PRODUCT_ID = process.env.DODO_PRODUCT_ID!; // Your subscription product ID from Dodo dashboard

router.use(authenticate);

// ─── GET /api/billing/status ──────────────────────────────────────────────────
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        stripeCustomerId: true, // reusing this field for dodo customer id
        stripeSubId: true,      // reusing this field for dodo subscription id
        subStatus: true,
        subPlan: true,
        trialEndsAt: true,
        isTrialActive: true,
      },
    });

    const now = new Date();
    const trialDaysLeft = user?.isTrialActive
      ? Math.max(0, Math.ceil((new Date(user.trialEndsAt).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      : 0;

    res.json({ ...user, trialDaysLeft });
  } catch (error: any) {
    logger.error('Billing status error:', error);
    res.status(500).json({ error: 'Failed to get billing status' });
  }
});

// ─── POST /api/billing/create-checkout ───────────────────────────────────────
router.post('/create-checkout', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, email: true, name: true, stripeCustomerId: true },
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    // Create checkout session with Dodo
    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: PRODUCT_ID, quantity: 1 }],
      customer: user.stripeCustomerId
        ? { customer_id: user.stripeCustomerId }
        : {
            email: user.email,
            name: user.name || undefined,
            create_new_customer: true,
          },
      return_url: `${process.env.FRONTEND_URL}/dashboard/billing?success=true`,
      metadata: { userId: user.id },
    } as any);

    res.json({ url: (session as any).url || (session as any).checkout_url });
  } catch (error: any) {
    logger.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ─── POST /api/billing/portal ─────────────────────────────────────────────────
router.post('/portal', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { stripeCustomerId: true },
    });

    if (!user?.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found' });
    }

    // Dodo customer portal
    const portal = await (dodo as any).customerPortal.sessions.create({
      customer_id: user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard/billing`,
    });

    res.json({ url: portal.url });
  } catch (error: any) {
    logger.error('Portal error:', error);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ─── GET /api/billing/invoices ────────────────────────────────────────────────
router.get('/invoices', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { stripeCustomerId: true },
    });

    if (!user?.stripeCustomerId) return res.json([]);

    const payments = await dodo.payments.list({ customer_id: user.stripeCustomerId } as any);

    const invoices = (payments as any).items?.map((p: any) => ({
      id: p.payment_id || p.id,
      amount: p.total_amount || p.amount,
      currency: p.currency,
      status: p.status,
      date: p.created_at,
      pdfUrl: p.invoice_url || null,
    })) || [];

    res.json(invoices);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

export default router;
