export interface MobilityDataSystemRow {
  system_id: string;
  name: string;
  location: string;
  country_code: string;
  url: string;
  auto_discovery_url: string;
  supported_versions: string;
  authentication_info_url: string;
  authentication_type: string;
  authentication_parameter_name: string;
}

export const parseCsv = (source: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("Unterminated quoted CSV field");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
};

export const parseMobilityDataSystemsCsv = (
  source: string,
): MobilityDataSystemRow[] => {
  const [rawHeaders, ...rows] = parseCsv(source);
  if (rawHeaders === undefined) return [];
  // MobilityData's canonical headings are title-cased and space/hyphen
  // separated (for example, "System ID" and "Auto-Discovery URL"). Keep the
  // parser tolerant of the historical snake_case spelling without accepting
  // ambiguous duplicate headings.
  const canonicalHeader = (header: string): string =>
    header
      .replace(/^\uFEFF/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const headers = rawHeaders.map(canonicalHeader);
  if (new Set(headers).size !== headers.length) {
    throw new Error("MobilityData systems.csv contains duplicate columns");
  }
  const indexOf = (name: string): number => headers.indexOf(name);
  const required = [
    "system_id",
    "name",
    "location",
    "country_code",
    "auto_discovery_url",
    // Authentication columns are part of the admission security boundary. If
    // upstream removes them, fail closed rather than treating every row as
    // public by omission.
    "authentication_info_url",
    "authentication_type",
    "authentication_parameter_name",
  ];
  if (required.some((name) => indexOf(name) < 0)) {
    throw new Error("MobilityData systems.csv is missing required columns");
  }

  const value = (row: readonly string[], name: string): string => {
    const index = indexOf(name);
    return index < 0 ? "" : (row[index]?.trim() ?? "");
  };
  return rows
    .map((row) => ({
      system_id: value(row, "system_id"),
      name: value(row, "name"),
      location: value(row, "location"),
      country_code: value(row, "country_code").toUpperCase(),
      url: value(row, "url"),
      auto_discovery_url: value(row, "auto_discovery_url"),
      supported_versions: value(row, "supported_versions"),
      authentication_info_url: value(row, "authentication_info_url"),
      authentication_type: value(row, "authentication_type"),
      authentication_parameter_name: value(
        row,
        "authentication_parameter_name",
      ),
    }))
    // Keep malformed rows visible to the admission pass so they can be
    // quarantined and counted instead of disappearing during parsing.
    .filter((row) => Object.values(row).some((field) => field.length > 0));
};
