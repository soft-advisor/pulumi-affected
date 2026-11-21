export function accountName(alias: string) {
  return `acme-${alias}`;
}

export function zoneName(domain: string) {
  return domain.toLowerCase();
}
