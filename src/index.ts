import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();

import { logger } from './utils/logger';
import { prisma } from './utils/prisma';
import authRoutes from './routes/auth';
import instagramRoutes from './routes/instagram'; // ✅ restored
import aiRoutes from './routes/ai';
import webhookRoutes from './routes/webhook';
import billingRoutes from './routes/billing';
import dashboardRoutes from './routes/dashboard';
import conversationRoutes from './routes/conversations';
import leadsRoutes from './routes/leads';
import keywordRoutes from './routes/keywords';
import './workers/automationQueue';

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;

// Security
app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-webhook-signature'],
}));

// Stripe needs raw body
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }));
app.use('/api/webhook/instagram', express.json());

// General middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', globalLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/instagram', instagramRoutes); // ✅ restored
app.use('/api/ai', aiRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/keywords', keywordRoutes); // ← ADD THIS


// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/auth/meta/callback', (req, res) => {
  res.send('Meta callback working');
});

// 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  try {
    await prisma.$connect();
    logger.info('✅ Database connected');
    app.listen(PORT, () => {
      logger.info(`🚀 InstaClient AI Backend running on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

export default app;
