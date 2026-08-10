// src/controllers/payment.controller.ts
import { Request, Response } from "express";
import axios from 'axios';

export const createProCheckout = async (req: Request, res: Response) => {
    try {
        const response = await axios.post(
            'https://api.paymongo.com/v1/checkout_sessions',
            {
                data: {
                    attributes: {
                        send_email_receipt: true,
                        show_line_items: true,
                        line_items: [
                            {
                                currency: 'PHP',
                                amount: 9900, // ₱99.00 in centavos
                                name: 'Casha-Ba Pro Monthly Subscription',
                                quantity: 1,
                            },
                        ],
                        payment_method_types: ['gcash', 'paymaya', 'card'],
                        success_url: 'http://localhost:3000/dashboard?subscribed=true',
                        cancel_url: 'http://localhost:3000/settings',
                    },
                },
            },
            {
                headers: {
                    Authorization: `Basic ${Buffer.from(process.env.PAYMONGO_SECRET_KEY + ':').toString('base64')}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        res.json({ checkoutUrl: response.data.data.attributes.checkout_url });
    } catch (err) {
        res.status(500).json({ message: 'Payment initiation failed' });
    }

};
