/** Upload references only. Server resolves authenticated ownership; names/data from
 * the browser never become trusted file paths or Person attachment content. */
export const PERSON_FILE_LIMITS = Object.freeze({ count: 4, fileBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024 });
export const PERSON_FILE_ACCEPT = '.txt,.md,.markdown,.csv,.tsv,.json,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.hpp,.cs,.sh,.bash,.zsh,.ps1,.sql,.html,.css,.xml,.yaml,.yml,.toml,.ini,.log,.png,.jpg,.jpeg,.webp,.gif';

export function validatePersonFiles(files, existing = []) {
  const all = [...existing, ...files];
  if (all.length > PERSON_FILE_LIMITS.count || all.reduce((n, f) => n + f.size, 0) > PERSON_FILE_LIMITS.totalBytes) throw new Error('person.filesLimit');
  for (const file of files) {
    if (!file.size || file.size > PERSON_FILE_LIMITS.fileBytes) throw new Error('person.filesLimit');
    const extension = '.' + String(file.name).split('.').at(-1).toLowerCase();
    if (!PERSON_FILE_ACCEPT.split(',').includes(extension)) throw new Error('person.filesUnsupported');
  }
}

export async function uploadPersonFiles(files, auth, signal) {
  const body = new FormData();
  for (const file of files) body.append('files', file, file.name);
  const token = auth.getActiveToken?.() || auth.token;
  const response = await fetch('/api/upload', { method: 'POST', body, signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error('person.filesFailed');
  const data = await response.json();
  if (!Array.isArray(data.files) || data.files.length !== files.length || data.files.some(f => typeof f.fileId !== 'string' || !f.fileId)) throw new Error('person.filesFailed');
  return data.files;
}
