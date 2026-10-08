/** Shared draft attachment lifecycle. Transport and validation stay with the caller.
 * upload(rows, signal) resolves ordered { fileId } references; each row has file/name.
 * validate(files, existingRows) may throw an i18n-key Error before any files are added.
 * enabled() guards user mutations, not receipt-driven uploadFiles() reconciliation.
 * Rows retain the original File for retries. clear/remove revoke draft previews;
 * release transfers preview ownership to a sent message and must NOT revoke them
 * unless the caller explicitly sets transferPreviews: false (reference-only messages).
 * scope() must include auth + logical composer identity; stale requests are aborted
 * and ignored even if their transport does not honour AbortSignal.
 */
export function useComposerAttachments({ upload, validate, enabled = () => true, scope = () => '' }) {
  const attachments = Vue.ref([]);
  const error = Vue.ref('');
  const uploading = Vue.computed(() => attachments.value.some(row => row.uploading));
  const filesReady = Vue.computed(() => attachments.value.every(row => hasAttachmentFileId(row) && !row.uploading && !row.uploadError));
  const jobs = new Set();
  let generation = 0;
  let disposed = false;

  const revoke = row => { if (row.preview) URL.revokeObjectURL(row.preview); };
  const clear = () => {
    generation++;
    for (const job of jobs) job.controller.abort();
    jobs.clear();
    attachments.value.forEach(revoke);
    attachments.value = [];
    error.value = '';
  };
  const current = (g, identity) => !disposed && generation === g && scope() === identity;

  async function request(rows) {
    const g = generation;
    const identity = scope();
    const job = { controller: new AbortController(), rows };
    if (disposed) throw Object.assign(new Error('stale'), { code: 'stale' });
    jobs.add(job);
    try {
      const result = await upload(rows, job.controller.signal);
      if (!current(g, identity) || job.controller.signal.aborted) throw Object.assign(new Error('stale'), { code: 'stale' });
      return result;
    } finally { jobs.delete(job); }
  }

  async function uploadRows(rows) {
    if (!enabled() || disposed) return;
    const pending = rows.filter(row => attachments.value.includes(row) && !row.uploading && !hasAttachmentFileId(row));
    if (!pending.length) return;
    error.value = '';
    const g = generation;
    const identity = scope();
    pending.forEach(row => { row.uploading = true; row.uploadError = false; });
    try {
      const result = await request(pending);
      if (!current(g, identity)) return;
      pending.forEach((row, index) => {
        if (!attachments.value.includes(row)) return;
        const fileId = typeof result?.[index]?.fileId === 'string' ? result[index].fileId.trim() : '';
        row.fileId = fileId || null;
        row.uploading = false;
        row.uploadError = !fileId;
      });
    } catch {
      if (!current(g, identity)) return;
      pending.forEach(row => {
        if (!attachments.value.includes(row)) return;
        row.uploading = false;
        row.uploadError = true;
      });
    }
  }

  async function addFiles(input) {
    if (!enabled() || disposed) return;
    const files = Array.from(input || []);
    if (!files.length) return;
    error.value = '';
    try { validate?.(files, attachments.value); }
    catch (reason) { error.value = reason.message; return; }
    const rows = files.map((file, index) => Vue.reactive({
      localId: `attachment-${nextAttachmentId++}`, file,
      name: uploadNameForFile(file, index), size: file.size,
      preview: file.type?.startsWith('image/') ? URL.createObjectURL(file) : null,
      uploading: false, uploadError: false, fileId: null,
    }));
    attachments.value.push(...rows);
    await uploadRows(rows);
  }

  function removeAttachment(rowOrIndex) {
    if (!enabled() || disposed) return;
    const index = typeof rowOrIndex === 'number' ? rowOrIndex : attachments.value.indexOf(rowOrIndex);
    const row = attachments.value[index];
    if (!row) return;
    attachments.value.splice(index, 1);
    revoke(row);
    error.value = '';
    for (const job of jobs) {
      if (job.rows.includes(row) && job.rows.every(item => !attachments.value.includes(item))) job.controller.abort();
    }
  }

  function release(rows = attachments.value.slice(), { transferPreviews = true } = {}) {
    // Only accepted rows leave the queue. Newer draft attachments are not consumed.
    attachments.value = attachments.value.filter(row => {
      if (!rows.includes(row)) return true;
      if (!transferPreviews) revoke(row);
      return false;
    });
    error.value = '';
  }

  Vue.watch(scope, clear, { flush: 'sync' });
  Vue.onBeforeUnmount(() => { disposed = true; clear(); });
  return {
    attachments, error, uploading, filesReady, addFiles, uploadRows,
    retryAttachment: row => uploadRows([row]), removeAttachment, clear, release,
    // Receipt reconciliation may reupload retained originals while input is locked.
    // These requests share cancellation/fencing but do not create draft previews.
    uploadFiles: files => request(files.map((file, index) => ({ file, name: uploadNameForFile(file, index) }))),
  };
}

let nextAttachmentId = 1;
export const SESSION_FILE_ACCEPT = 'image/*,text/*,.pdf,.doc,.docx,.xls,.xlsx,.json,.md,.py,.js,.ts,.css,.html';
export const hasAttachmentFileId = row => typeof row?.fileId === 'string' && !!row.fileId.trim();

export function uploadNameForFile(file, index = 0) {
  const name = typeof file?.name === 'string' ? file.name.trim() : '';
  if (name) return name;
  const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'text/plain': '.txt', 'application/json': '.json' };
  return `pasted-${file?.type?.startsWith('image/') ? 'image' : 'file'}-${Date.now()}-${index + 1}${extensions[String(file?.type || '').toLowerCase()] || ''}`;
}

/** Session's existing multipart wire contract, with active (including SSO) token. */
export async function uploadSessionAttachments(rows, auth, signal) {
  const body = new FormData();
  rows.forEach(row => body.append('files', row.file, row.name));
  const token = auth.getActiveToken?.() || auth.token;
  const response = await fetch('/api/upload', { method: 'POST', body, signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error('Upload failed');
  const result = await response.json();
  return Array.isArray(result.files) ? result.files : [];
}

export function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
