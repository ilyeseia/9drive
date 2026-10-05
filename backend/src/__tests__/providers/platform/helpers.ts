import { randomUUID } from 'node:crypto';
import { prisma } from '../../../config/prisma.js';

export async function pingDb(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function createTestUser(label: string) {
  return prisma.user.create({
    data: {
      email: `platform-${label}-${randomUUID().slice(0, 8)}@9drive.test`,
      name: 'Platform Test',
      passwordHash: 'not-a-real-password-hash',
    },
  });
}
