import dotenv from 'dotenv';
dotenv.config();

export const ENV = {
    APP_NAME: process.env.APP_NAME || 'CashaBa',
    PORT: parseInt(process.env.PORT || '8000', 10),
    NODE_ENV: process.env.NODE_ENV || 'development',
    DATABASE_URL: process.env.DATABASE_URL,
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
    BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:8000',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,

    SMTP: {
        HOST: process.env.SMTP_HOST,
        PORT: parseInt(process.env.SMTP_PORT || '587', 10),
        SECURE: process.env.SMTP_SECURE === 'true',
        USER: process.env.SMTP_USER,
        PASS: process.env.SMTP_PASSWORD,
        FROM: process.env.MAIL_FROM,
    }
};

export function assertProductionConfig() {
    if ((process.env.NODE_ENV || ENV.NODE_ENV) !== 'production') return;
    const required = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'FRONTEND_URL', 'BACKEND_URL', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const;
    const missing = required.filter(name => !process.env[name]?.trim());
    const billingMode = (process.env.BILLING_MODE || '').toLowerCase();
    if (!['disabled', 'paymongo', 'paymongo_test'].includes(billingMode)) missing.push('BILLING_MODE' as typeof required[number]);
    if (billingMode === 'paymongo_test' && !process.env.PAYMONGO_SECRET_KEY?.trim().startsWith('sk_test_')) {
        throw new Error('PayMongo test checkout requires a secret test key. Live payments are blocked.');
    }
    if (billingMode === 'paymongo') {
        if (!process.env.PAYMONGO_SECRET_KEY?.trim()) missing.push('PAYMONGO_SECRET_KEY' as typeof required[number]);
        if (!process.env.PAYMONGO_WEBHOOK_SECRET?.trim()) missing.push('PAYMONGO_WEBHOOK_SECRET' as typeof required[number]);
        if (process.env.PAYMONGO_SECRET_KEY?.trim() && !process.env.PAYMONGO_SECRET_KEY.trim().startsWith('sk_live_')) {
            throw new Error('Production PayMongo billing requires a live secret key. Payment collection remains pending.');
        }
    }
    if (missing.length) throw new Error(`Missing production configuration: ${[...new Set(missing)].join(', ')}`);
}
