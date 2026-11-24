export function safeJianyingFolderName(value) {
  return (String(value || '辰思AI成片').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim() || '辰思AI成片').slice(0, 80);
}

export function joinJianyingPath(root, child) {
  return `${String(root || '').replace(/[\\/]+$/g, '')}/${String(child || '').replace(/^[\\/]+/g, '')}`;
}

export function replaceJianyingPaths(value, replacements) {
  let output = String(value ?? '');
  for (const replacement of replacements) {
    const pairs = [
      [replacement.from.replace(/\\/g, '/'), replacement.to.replace(/\\/g, '/')],
      [replacement.from.replace(/\//g, '\\'), replacement.to.replace(/\//g, '\\')]
    ];
    for (const [from, to] of pairs) if (from) output = output.split(from).join(to);
  }
  return output;
}

export function rewriteJianyingJson(value, replacements, depth = 0) {
  if (Array.isArray(value)) return value.map((item) => rewriteJianyingJson(item, replacements, depth));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, current]) => [key, rewriteJianyingJson(current, replacements, depth)]));
  }
  if (typeof value !== 'string') return value;
  const rewritten = replaceJianyingPaths(value, replacements);
  const trimmed = rewritten.trim();
  if (depth < 4 && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    try {
      return JSON.stringify(rewriteJianyingJson(JSON.parse(rewritten), replacements, depth + 1));
    } catch {}
  }
  return rewritten;
}

export function mergeJianyingIndexData(index, indexEntry, { folderName, rootPath, draftPath, replacements }) {
  if (!index || !Array.isArray(index.all_draft_store)) throw new Error('剪映草稿索引格式无效');
  const result = structuredClone(index);
  const entry = rewriteJianyingJson(indexEntry, replacements);
  entry.draft_name = folderName;
  entry.draft_fold_path = draftPath;
  entry.draft_root_path = rootPath;
  entry.draft_json_file = joinJianyingPath(draftPath, 'draft_content.json');
  entry.draft_cover = joinJianyingPath(draftPath, 'draft_cover.jpg');
  const stores = result.all_draft_store.filter((item) => String(item?.draft_id || '').toUpperCase() !== String(entry.draft_id || '').toUpperCase()
    && String(item?.draft_fold_path || '').replace(/\\/g, '/').toLowerCase() !== draftPath.toLowerCase());
  result.all_draft_store = [entry, ...stores];
  result.draft_ids = result.all_draft_store.length;
  result.root_path = rootPath;
  return result;
}

