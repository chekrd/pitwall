// No spaces in the path: Claude Code reads a pasted path as one file only when it has none.
export const uploadsDir = (home: string) => `${home}/Library/Caches/pitwall/uploads`;

export const UPLOAD_IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const UPLOAD_DIR_NAME = /^[\w-]+$/;
export const UPLOAD_IMAGE_NAME = /^\w[\w.-]*\.(?:png|jpe?g|gif|webp)$/i;

// A picture sent with a task's first prompt, or one Claude Code took as text, reaches Claude as the path of its upload.
export function uploadedImages(text: string, home: string) {
  if (!home) return { text, images: [] };
  const dir = uploadsDir(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(String.raw`(?<![\w./-])${dir}/([\w-]+/\w[\w.-]*\.(?:png|jpe?g|gif|webp))(?![\w.-])`, 'gi');
  const images = [...new Set([...text.matchAll(found)].map((m) => m[1]))];
  const rest = text.replace(found, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: rest, images };
}
