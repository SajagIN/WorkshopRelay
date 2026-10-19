import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Used by `prisma migrate`. Falls back to a placeholder so that
    // `prisma generate` works in build environments without a .env;
    // migrate commands still fail loudly on a wrong URL at connect time.
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/workshop_relay',
  },
});
