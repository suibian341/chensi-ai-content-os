export function subtitleTextFromAudioAsset(asset, project) {
  if (!asset) return '';
  // Prefer a complete script saved on a related output. Older generated audio
  // assets may only keep a short description, while the output retains the
  // full narration text.
  const relatedOutputs = (project?.outputs || []).filter((output) => (
    output.narrationAssetId === asset.id
    || output.sourceAssetId === asset.id
    || output.audioSourceAssetId === asset.id
  ));
  const candidates = [
    ...relatedOutputs.flatMap((output) => [output.speechScript, output.sourceScript, output.subtitleText]),
    asset.subtitleText,
    asset.speechScript,
    asset.transcript,
    asset.text,
    asset.description
  ];
  return candidates
    .map((value) => String(value || '').trim())
    .find((value) => value.length > 0) || '';
}
