export type EquivalentLinkCandidate = {
  importId: string;
  productId: string;
  sourceSkuKey: string;
  linkMethod: string;
  relationshipRowNumber: number;
  evidenceKey: string;
};

function compareText(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function candidateIdentity(candidate: EquivalentLinkCandidate) {
  return [
    candidate.importId,
    candidate.productId,
    candidate.sourceSkuKey,
    candidate.linkMethod,
  ].join("\u0000");
}

export function deduplicateEquivalentLinkCandidates<T extends EquivalentLinkCandidate>(candidates: T[]) {
  const ordered = [...candidates].sort((left, right) => (
    left.relationshipRowNumber - right.relationshipRowNumber
    || compareText(left.evidenceKey, right.evidenceKey)
  ));
  const identities = new Set<string>();

  return ordered.filter((candidate) => {
    const identity = candidateIdentity(candidate);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
}
