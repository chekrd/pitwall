// Also imported by the UI, so nothing imported here may load the server.

interface Named {
  name: string;
}

export const slashName = (text: string) => text.match(/^\/(\S+)/)?.[1] ?? null;

// Whether `/name …` names a command or skill of the list. A plugin's are listed as `<plugin>:<name>`, and one typed by
// its bare name is meant as that command too, so it is typed as it is and never taken for an answer.
export function knowsCommand(list: readonly Named[], text: string) {
  const name = slashName(text);
  return !!name && list.some((c) => c.name === name || c.name.endsWith(`:${name}`));
}

// How the board invokes a skill: by its bare name when a command or skill of that name is listed, else by the name its
// plugin gives it.
export function invocation(list: readonly Named[], name: string, plugin = name) {
  if (list.some((c) => c.name === name)) return `/${name}`;
  return list.some((c) => c.name === `${plugin}:${name}`) ? `/${plugin}:${name}` : `/${name}`;
}

export const rpiInvocation = (list: readonly Named[]) => invocation(list, 'rpi');
