import { createHash, timingSafeEqual } from 'node:crypto'

export function matchesDevelopmentBearer(header: string | undefined, expectedToken: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false
  const suppliedToken = header.slice('Bearer '.length)
  if (suppliedToken.length === 0) return false
  const suppliedDigest = createHash('sha256').update(suppliedToken).digest()
  const expectedDigest = createHash('sha256').update(expectedToken).digest()
  return timingSafeEqual(suppliedDigest, expectedDigest)
}
