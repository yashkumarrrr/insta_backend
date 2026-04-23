import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { prisma } from '../utils/prisma';
import toast from 'react-hot-toast';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  const { page = '1', limit = '20', status } = req.query as Record<string, string>;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const where: any = { userId: req.user!.id };
  if (status) where.status = status;
  const [leads, total] = await Promise.all([
    prisma.lead.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take: parseInt(limit),
      include: { conversation: { select: { messageCount: true, lastMessageAt: true } } },
    }),
    prisma.lead.count({ where }),
  ]);
  res.json({ leads, total, page: parseInt(page) });
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const lead = await prisma.lead.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const updated = await prisma.lead.update({ where: { id: req.params.id }, data: req.body });
  res.json(updated);
});

export default router;
