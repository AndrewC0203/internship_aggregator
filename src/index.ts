import { prisma } from "./db.js";

// Smoke test: proves the app compiles, connects to Postgres, and can read the
// listings table. Replace with the real entrypoint (Fastify server) later.
async function main() {
  const count = await prisma.listing.count();
  console.log(`Connected. listings row count: ${count}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
