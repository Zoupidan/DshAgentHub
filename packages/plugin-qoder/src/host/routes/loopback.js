/**
 * loopback + Host 栅栏（状态/凭据/操作路由共用一份，fail-closed）。
 * @module host/routes/loopback
 */
import { isIP } from 'node:net';

export function isLoopback(req) {
  let remote = req?.socket?.remoteAddress;
  if (typeof remote !== 'string') return false;
  if (remote.startsWith('::ffff:')) remote = remote.slice('::ffff:'.length);
  if (isIP(remote) === 4) return remote.startsWith('127.');
  return isIP(remote) === 6 && remote === '::1';
}

export function isLoopbackHost(req) {
  const raw = req?.headers?.host;
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  const host = raw.trim();
  let name = host;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return false;
    name = host.slice(1, end);
  } else {
    const lastColon = host.lastIndexOf(':');
    if (lastColon >= 0 && host.indexOf(':') === lastColon) name = host.slice(0, lastColon);
  }
  if (name === 'localhost') return true;
  if (isIP(name) === 4) return name.startsWith('127.');
  return isIP(name) === 6 && name === '::1';
}
