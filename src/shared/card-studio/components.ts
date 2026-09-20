/** The name shown in 本轮写入 for a file inside a card project, e.g. 世界书/人设/120-红孩儿.md → 人设·红孩儿. */
export function componentName(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = clean.split('/');
  const stem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/^\d+[-_\s]+/, '');
  if (clean === '设计书.md') return '设计书';
  if (clean === '卡项目.json') return '卡项目登记';
  if (clean === '资料/索引.md') return '资料索引';
  if (parts[0] === '资料' && parts[1] === '分章') return '资料分章';
  if (parts[0] === '资料' && parts[1] === '原件') return '资料原件';
  if (parts[0] === '世界书' && parts.length >= 3) {
    const file = stem(parts.at(-1)!);
    if (file === '出处索引') return `出处索引（${parts[1]}）`;
    if (file === '人物模板' || file === '剧情模板') return file;
    return `${parts[1]}·${file}`;
  }
  if (['正则', '脚本', '开场白'].includes(parts[0]) && parts.length >= 2) return `${parts[0]}·${stem(parts[1])}`;
  if (parts[0] === '封面' || parts[0] === '导出') return parts[0];
  return clean;
}
