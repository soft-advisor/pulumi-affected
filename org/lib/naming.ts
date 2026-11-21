export function accountName(alias: string) {
  return `acme-co-${alias}`;
}

export function zoneName(domain: string) {
  return domain.toLowerCase();
}
