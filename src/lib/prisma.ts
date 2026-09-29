import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const testSchema = process.env.TEST_DATABASE_SCHEMA;
if (testSchema && (!/^casha_test_[a-f0-9]{32}$/.test(testSchema) || !process.env.TEST_DATABASE_URL)) {
  throw new Error('An isolated test schema requires TEST_DATABASE_URL and a generated schema name');
}
const connectionString = testSchema ? process.env.TEST_DATABASE_URL! : `${process.env.DATABASE_URL}`;

// Explicitly set the schema for raw SQL used by financial locks as well as
// Prisma model queries. Some hosted Postgres connections have a different
// default search_path, which otherwise makes login and financial writes fail.
const adapter = new PrismaPg({ connectionString }, { schema: testSchema || 'public' });
const prisma = new PrismaClient({ adapter });

export function qualifiedTable(name: 'User' | 'Subscription' | 'BillingEvent') {
  return `"${testSchema || 'public'}"."${name}"`;
}

export { prisma };
