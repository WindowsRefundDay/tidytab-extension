export function summarizeSnippetFailures(failures, exampleLimit = 4) {
  const skipped = (failures || []).filter(Boolean);
  if (!skipped.length) {
    return [];
  }

  const examples = skipped
    .slice(0, exampleLimit)
    .map((failure) => failure.title || failure.url || "Untitled")
    .filter(Boolean);
  const remainder = skipped.length - examples.length;
  const exampleText = examples.length ? ` Examples: ${examples.join("; ")}${remainder > 0 ? `; and ${remainder} more` : ""}.` : "";

  return [
    `Page snippets were unavailable for ${skipped.length} tab${skipped.length === 1 ? "" : "s"}; used title, URL, and history context instead.${exampleText}`
  ];
}
