/**
 * The panel learns whether license suggestions are enabled from `getAssetFaces`. Scan results
 * (`ingestAsset` / `ingestVideoFrames`) do not carry that flag, so replacing the panel's data with
 * a scan result would silently switch suggestions off until the next full reload. Keep the last
 * known value whenever the new data does not state it.
 */
export function withLicenseFlag(previous, next) {
  if (!next || typeof next !== 'object') return next;
  if (next.licenseSuggestionsEnabled !== undefined) return next;
  if (previous && previous.licenseSuggestionsEnabled !== undefined) {
    return { ...next, licenseSuggestionsEnabled: previous.licenseSuggestionsEnabled };
  }
  return next;
}

/** Stable key of the people on an asset, so suggestions refresh when a re-scan changes them. */
export function licensePeopleKey(faces) {
  return (Array.isArray(faces) ? faces : [])
    .map((f) => f && f.groupId)
    .filter(Boolean)
    .sort()
    .join(',');
}
