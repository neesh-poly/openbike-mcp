export const foldSearchText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ")
    .trim();

export const matchesSearchText = (candidate: string, query: string): boolean => {
  const normalizedQuery = foldSearchText(query);
  return normalizedQuery.length === 0
    ? true
    : foldSearchText(candidate).includes(normalizedQuery);
};
