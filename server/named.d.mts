type NamedFile = {
  version: unknown;
  review: unknown;
  people: unknown;
  coverage: unknown;
  pending: unknown;
  use: unknown;
  advice: unknown;
};

export function namedParts(named: NamedFile): {
  named: Omit<NamedFile, 'advice'>;
  advice: Pick<NamedFile, 'version' | 'advice'>;
};
