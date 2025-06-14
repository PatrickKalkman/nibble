import crypto from 'crypto';
import pino from 'pino';

const logger = pino();

export const createAuthMiddleware = (secretKey) => {
  return async (request, reply) => {
    const token = request.headers['x-api-key'] || request.headers['authorization']?.replace('Bearer ', '');
    
    if (!token) {
      reply.code(401).send({ error: 'Missing API key' });
      return;
    }
    
    if (token !== secretKey) {
      reply.code(401).send({ error: 'Invalid API key' });
      return;
    }
  };
};

export const verifyWebhookSignature = (secret) => {
  return async (request, reply) => {
    const signature = request.headers['x-hub-signature-256'];
    
    if (!signature) {
      reply.code(401).send({ error: 'Missing signature' });
      return;
    }
    
    const payload = JSON.stringify(request.body);
    const expectedSignature = `sha256=${crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')}`;
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      reply.code(401).send({ error: 'Invalid signature' });
      return;
    }
  };
};