import type { Driver } from '../../server/delivery.ts';

// Claude Code's prompt as the board's pastes reach it, as 2.1.330 takes them in a terminal of 13 rows or more: a paste
// of over 800 characters or 2 line breaks shows as a placeholder, and Enter sends the prompt as it shows, so a command
// that starts with one goes to Claude as pasted text.
export function claudePrompt(enter: (prompt: string) => void): Driver {
  let shown = '';
  let pastes = 0;
  return {
    paste: async (text) => {
      const breaks = text.split('\n').length - 1;
      shown += text.length > 800 || breaks > 2 ? `[Pasted text #${++pastes}${breaks ? ` +${breaks} lines` : ''}]` : text;
    },
    keys: async (strokes) => {
      if (!strokes.some((k) => 'key' in k && k.key === 'enter')) return;
      enter(shown);
      shown = '';
    },
  };
}
