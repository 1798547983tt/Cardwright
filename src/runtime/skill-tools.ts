import { readFile, stat } from 'node:fs/promises';
import { defineTool, type Skill, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { canonicalPath } from './permissions.ts';

export function searchSkillCatalog(skills: readonly Skill[], query: string, limit = 8) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return skills.filter(skill => !skill.disableModelInvocation).map(skill => {
    const name = skill.name.toLocaleLowerCase();
    const text = `${name} ${skill.description.toLocaleLowerCase()}`;
    const score = words.reduce((sum, word) => sum + (name === word ? 10 : name.includes(word) ? 4 : text.includes(word) ? 1 : 0), 0);
    return { skill, score };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0))
    .slice(0, Math.max(1, Math.min(12, limit))).map(({ skill }) => ({ name: skill.name, description: skill.description.slice(0, 600) }));
}

export function createSkillTools(catalog: () => readonly Skill[], cwd: string, loaded: (path: string) => void): ToolDefinition[] {
  return [
    defineTool({ name: 'search_skills', label: 'Find skills', description: 'Find enabled local skills relevant to specialized work. Search by task, topic or skill name; use_skill loads a match. Explicit-only skills are excluded.',
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 240 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })) }),
      execute: async (_id, args) => {
        const matches = searchSkillCatalog(catalog(), args.query, args.limit);
        return { content: [{ type: 'text', text: JSON.stringify(matches) }], details: { matches } };
      },
    }),
    defineTool({ name: 'use_skill', label: 'Use skill', description: 'Read a skill returned by search_skills. Follow applicable instructions and resolve references relative to its directory. Explicit-only skills require the user’s slash selection.',
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 160 }) }),
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted();
        const skill = catalog().find(item => item.name === args.name && !item.disableModelInvocation);
        if (!skill) throw new Error('This skill is disabled, unavailable, or requires explicit user selection.');
        const path = await canonicalPath(skill.filePath, cwd);
        const original = skill.filePath.replaceAll('\\', '/').toLowerCase();
        if (path.replaceAll('\\', '/').toLowerCase() !== original) throw new Error('The skill path changed. Refresh the skill catalog.');
        const info = await stat(path);
        if (!info.isFile() || info.size > 256 * 1024) throw new Error('The skill is unavailable or exceeds the text limit.');
        const body = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
        signal?.throwIfAborted(); loaded(path);
        return { content: [{ type: 'text', text: `Skill: ${skill.name}\nLocation: ${path}\nResolve references from: ${skill.baseDir}\n\n${body}` }], details: { name: skill.name, path } };
      },
    }),
  ];
}
