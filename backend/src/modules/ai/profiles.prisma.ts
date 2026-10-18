/** Prisma-backed ProfileStore. */

import { prisma } from '../../config/prisma.js';
import type { ProfileStore } from './profiles.js';

export function createPrismaProfileStore(): ProfileStore {
  return {
    list: () => prisma.aiModelProfile.findMany({ orderBy: { createdAt: 'asc' } }),
    get: (id) => prisma.aiModelProfile.findUnique({ where: { id } }),
    create: (data) => prisma.aiModelProfile.create({ data }),
    async update(id, patch) {
      try {
        return await prisma.aiModelProfile.update({ where: { id }, data: patch });
      } catch {
        return null;
      }
    },
    async delete(id) {
      const result = await prisma.aiModelProfile.deleteMany({ where: { id } });
      return result.count > 0;
    },
    async setActive(id) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.aiModelProfile.updateMany({ where: { isActive: true }, data: { isActive: false } });
          if (id !== null) await tx.aiModelProfile.update({ where: { id }, data: { isActive: true } });
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
