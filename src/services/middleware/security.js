// services/middleware/security.js
import pino from 'pino';

const logger = pino();

// Security headers middleware
export const securityHeaders = () => {
  return async (request, reply) => {
    reply.headers({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'X-XSS-Protection': '1; mode=block',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'",
      'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
    });
  };
};

// Block suspicious requests
export const blockSuspiciousRequests = () => {
  const suspiciousPatterns = [
    /\.git\//,
    /\.env/,
    /\.aws/,
    /\.ssh/,
    /wp-admin/,
    /wp-login/,
    /admin/,
    /phpmyadmin/,
    /\.php$/,
    /\.sql$/,
    /\.bak$/,
    /\.backup$/,
    /\.old$/,
    /\.config$/,
    /\.log$/,
    /\.xml$/,
    /sitemap\.xml$/,
    /robots\.txt$/,
    /favicon\.ico$/,
    /apple-touch-icon/,
    /\.well-known/,
    /aws/,
    /azure/,
    /gcp/,
    /docker/,
    /kubernetes/,
    /\.json$/,
    /package\.json$/,
    /composer\.json$/,
    /yarn\.lock$/,
    /package-lock\.json$/
  ];

  const suspiciousUserAgents = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scan/i,
    /curl/i,
    /wget/i,
    /python/i,
    /go-http-client/i,
    /nikto/i,
    /sqlmap/i,
    /nmap/i,
    /masscan/i,
    /zap/i,
    /burp/i,
    /nuclei/i
  ];

  return async (request, reply) => {
    const url = request.url.toLowerCase();
    const userAgent = request.headers['user-agent'] || '';
    const host = request.headers.host || '';

    // Block suspicious URL patterns
    if (suspiciousPatterns.some(pattern => pattern.test(url))) {
      logger.warn({
        ip: request.ip,
        url: request.url,
        userAgent,
        host,
        headers: request.headers,
        type: 'suspicious_url'
      }, 'Blocked suspicious request');
      
      reply.code(404).send({ error: 'Not found' });
      return;
    }

    // Block suspicious user agents
    if (suspiciousUserAgents.some(pattern => pattern.test(userAgent))) {
      logger.warn({
        ip: request.ip,
        url: request.url,
        userAgent,
        host,
        type: 'suspicious_user_agent'
      }, 'Blocked suspicious user agent');
      
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }

    // Block requests to non-existent hosts (unless it's your domain)
    const allowedHosts = [
      'nibble.practical-engineer.ai',
      'localhost',
      '127.0.0.1',
      process.env.SERVER_IP || '84.235.169.140'
    ];

    if (!allowedHosts.includes(host)) {
      logger.warn({
        ip: request.ip,
        url: request.url,
        userAgent,
        host,
        type: 'invalid_host'
      }, 'Blocked request to invalid host');
      
      reply.code(404).send({ error: 'Not found' });
      return;
    }
  };
};

// Enhanced rate limiting with IP tracking
export const createAdvancedRateLimiter = (options = {}) => {
  const {
    maxRequests = 10,
    windowMs = 60000,
    blockDuration = 300000, // 5 minutes
    maxViolations = 3
  } = options;

  const requests = new Map();
  const violations = new Map();
  const blockedIPs = new Map();

  return async (request, reply) => {
    const key = request.ip;
    const now = Date.now();

    // Check if IP is currently blocked
    const blockInfo = blockedIPs.get(key);
    if (blockInfo && now < blockInfo.until) {
      logger.warn({
        ip: key,
        url: request.url,
        blockedUntil: new Date(blockInfo.until),
        type: 'blocked_ip'
      }, 'Request from blocked IP');
      
      reply.code(429).send({ 
        error: 'IP temporarily blocked',
        retryAfter: Math.ceil((blockInfo.until - now) / 1000)
      });
      return;
    }

    // Clean expired blocks
    if (blockInfo && now >= blockInfo.until) {
      blockedIPs.delete(key);
      violations.delete(key);
    }

    const windowStart = now - windowMs;
    
    // Clean old entries
    const userRequests = requests.get(key) || [];
    const recentRequests = userRequests.filter(time => time > windowStart);
    
    if (recentRequests.length >= maxRequests) {
      // Track violations
      const userViolations = violations.get(key) || 0;
      violations.set(key, userViolations + 1);
      
      logger.warn({
        ip: key,
        url: request.url,
        requests: recentRequests.length,
        violations: userViolations + 1,
        type: 'rate_limit_exceeded'
      }, 'Rate limit exceeded');

      // Block IP if too many violations
      if (userViolations + 1 >= maxViolations) {
        blockedIPs.set(key, { until: now + blockDuration });
        logger.warn({
          ip: key,
          violations: userViolations + 1,
          blockedUntil: new Date(now + blockDuration),
          type: 'ip_blocked'
        }, 'IP blocked due to repeated violations');
      }
      
      reply.code(429).send({ 
        error: 'Too many requests',
        retryAfter: Math.ceil(windowMs / 1000)
      });
      return;
    }
    
    recentRequests.push(now);
    requests.set(key, recentRequests);
  };
};

// Geo-blocking (optional - you can restrict to certain countries)
export const createGeoBlock = (allowedCountries = []) => {
  return async (request, reply) => {
    // This would require a GeoIP service like MaxMind
    // For now, just log the country if available from headers
    const country = request.headers['cf-ipcountry'] || 
                   request.headers['x-country'] ||
                   request.headers['geoip-country'];
    
    if (country) {
      logger.info({
        ip: request.ip,
        country,
        url: request.url,
        type: 'geo_info'
      }, 'Request with country info');
      
      // If you want to block certain countries, uncomment:
      // const blockedCountries = ['CN', 'RU', 'KP']; // Example
      // if (blockedCountries.includes(country)) {
      //   reply.code(403).send({ error: 'Access denied' });
      //   return;
      // }
    }
  };
};

// Request logging with security focus
export const securityLogger = () => {
  return async (request, reply) => {
    // Log all requests for security monitoring
    logger.info({
      ip: request.ip,
      method: request.method,
      url: request.url,
      userAgent: request.headers['user-agent'],
      referer: request.headers.referer,
      host: request.headers.host,
      timestamp: new Date().toISOString(),
      type: 'request_log'
    }, 'Incoming request');
  };
};