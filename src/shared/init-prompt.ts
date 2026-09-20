/**
 * What `/init` sends (§6.2): the project's own instruction file, updated when it has one and written when it has none.
 * `file` is the instruction file the project already has, `AGENTS.md` first, or null.
 */
export function initPrompt(file: string | null, language: 'zh' | 'en'): string {
  const target = file ?? 'CLAUDE.md';
  const zh = [
    file ? `请读一遍这个项目，然后更新 \`${file}\`。` : '请读一遍这个项目，然后新建 `CLAUDE.md`。',
    '',
    '先看清楚再写：目录结构、构建与测试命令、代码风格与命名习惯、测试怎么跑、有哪些约定和坑。',
    '要写的是下一个接手的人（或下一个 agent）真正需要知道的事：',
    '1. 这个项目是做什么的，入口在哪；',
    '2. 常用命令（安装、开发、构建、检查、测试），照抄真实可用的命令；',
    '3. 代码风格与约定，只写这个项目特有的，通用常识不写；',
    '4. 目录速查：哪类代码放在哪里；',
    '5. 容易踩的坑与注意事项。',
    '',
    file ? `保留 \`${file}\` 里仍然正确的内容，只补充和修正；不要推倒重写，也不要删掉你没验证过的说明。` : '控制篇幅，宁可少而准，不要写成流水账。',
    '不要写没验证过的命令；拿不准的先跑一下或者读配置文件确认。',
    `写完只改 \`${target}\` 这一个文件，并说明你改了什么。`,
  ].join('\n');
  const en = [
    file ? `Read this project, then update \`${file}\`.` : 'Read this project, then write a new `CLAUDE.md`.',
    '',
    'Look before you write: the directory layout, the build and test commands, the code style and naming, how tests run, the conventions and the traps.',
    'Write what the next person (or the next agent) actually needs:',
    '1. what this project is and where it starts;',
    '2. the commands that matter (install, develop, build, check, test), copied from what really works;',
    '3. the conventions that belong to this project, not general knowledge;',
    '4. where each kind of code lives;',
    '5. the traps worth knowing.',
    '',
    file ? `Keep what \`${file}\` already gets right; add and correct, do not rewrite it, and do not delete guidance you have not checked.` : 'Keep it short and accurate rather than exhaustive.',
    'Never write a command you have not verified; run it or read the configuration first.',
    `Change only \`${target}\`, and say what you changed.`,
  ].join('\n');
  return language === 'en' ? en : zh;
}
