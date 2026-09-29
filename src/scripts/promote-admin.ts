import { prisma } from "../lib/prisma";

const email = process.argv[2]?.trim().toLowerCase();

if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error("Usage: npm run admin:promote -- user@example.com");
  process.exitCode = 1;
} else {
  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, accountRole: true },
    });

    if (!user) {
      console.error(`No registered account was found for ${email}. Sign up first, then run this command again.`);
      process.exitCode = 1;
    } else if (user.accountRole === "ADMIN") {
      console.log(`${user.email} is already an administrator.`);
    } else {
      await prisma.user.update({
        where: { id: user.id },
        data: { accountRole: "ADMIN" },
      });
      console.log(`${user.email} is now an administrator. Log out and sign in again to refresh the access token.`);
    }
  } catch (error) {
    console.error("Unable to promote the account. Check DATABASE_URL and the database connection.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
