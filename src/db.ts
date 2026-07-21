import { PrismaClient } from "@prisma/client";

// Single shared Prisma client for the whole app. A new PrismaClient opens its
// own connection pool, so creating them ad-hoc exhausts Postgres connections.
// One instance, imported everywhere, is the standard pattern.
export const prisma = new PrismaClient();
