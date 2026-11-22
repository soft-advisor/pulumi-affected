/** Account names are prefixed with the company */
export function accountName(alias: string): string {
  return `acme-${alias}`;
}

export function zoneName(domain: string): string {
  return domain.toLowerCase();
}
