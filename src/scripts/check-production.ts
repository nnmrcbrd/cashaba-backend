import 'dotenv/config';
import { assertProductionConfig } from '@/config/env';
import { verifyMailConnection } from '@/services/mail';

process.env.NODE_ENV = 'production';
assertProductionConfig();
await verifyMailConnection();
console.log('Production configuration and recovery-email SMTP connection are valid.');
