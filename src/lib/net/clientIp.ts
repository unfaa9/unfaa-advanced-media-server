import { Request } from 'express';
import ipaddr from 'ipaddr.js';
import proxyaddr from 'proxy-addr';
import config from '../../config';

// Snapshot of https://www.cloudflare.com/ips/ — review when Cloudflare publishes changes.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const useCloudflare = config.trustedProxies.includes('cloudflare');
// The reverse proxy (nginx/Caddy) and private networks; "cloudflare" is handled separately.
const trust = proxyaddr.compile(
  config.trustedProxies.filter(p => p !== 'cloudflare')
);
const isCloudflare = proxyaddr.compile(CLOUDFLARE_RANGES);

// Walks X-Forwarded-For back through TRUSTED_PROXIES. CF-Connecting-IP is honoured only when
// that walk ends at a Cloudflare edge, so a client hitting the VPS directly cannot forge it.
export const clientIp = (req: Request): string => {
  const addr = proxyaddr(req, trust);
  if (useCloudflare && isCloudflare(addr, 0)) {
    const cf = req.get('cf-connecting-ip');
    if (cf && ipaddr.isValid(cf)) return cf;
  }
  return addr;
};
