/**
 * Exact prefix matching on SQLite key columns: JIDs (`{chat}#agent:…`),
 * folders and router state keys.
 *
 * LIKE reads `_` and `%` in the value as wildcards and ignores ASCII case, so
 * `web:team_a#agent:%` also matched `web:teamXa#agent:…` and `web:TEAM_A#…`.
 * Under the default binary collation every key that starts with `prefix`
 * sorts at or after it and before the prefix with its last character
 * incremented, so `col >= @from AND col < @to` is exact and can use an index
 * on the column.
 */
export function keyPrefixRange(prefix: string): { from: string; to: string } {
  const last = prefix.charCodeAt(prefix.length - 1);
  // Callers end their prefixes with a separator such as `:`; a surrogate or
  // the highest code unit would have no simple successor.
  if (!(last >= 0x20 && last < 0x7f)) {
    throw new Error(`Key prefix must end in printable ASCII: ${prefix}`);
  }
  return {
    from: prefix,
    to: prefix.slice(0, -1) + String.fromCharCode(last + 1),
  };
}
