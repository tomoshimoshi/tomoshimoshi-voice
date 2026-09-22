export const packages = {
  credit_1000: { amount: 1000n, env: "STRIPE_PRICE_CREDIT_1000" },
  credit_2000: { amount: 2000n, env: "STRIPE_PRICE_CREDIT_2000" },
  credit_5000: { amount: 5000n, env: "STRIPE_PRICE_CREDIT_5000" },
} as const;
export type PackageCode = keyof typeof packages;
export function packageDefinition(code: string) {
  if (!Object.hasOwn(packages, code)) throw new Error("UNSUPPORTED_PACKAGE");
  return packages[code as PackageCode];
}
