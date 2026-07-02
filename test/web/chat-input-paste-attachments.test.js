import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const chatInputSource = readFileSync(join(repoRoot, 'web/components/ChatInput.js'), 'utf8');

describe('ChatInput paste attachments', () => {
  it('assigns a stable upload filename when clipboard files have an empty name', () => {
    expect(chatInputSource).toContain('const uploadNameForFile = (file, index) =>');
    expect(chatInputSource).toContain("const prefix = isImage ? 'pasted-image' : 'pasted-file';");
    expect(chatInputSource).toContain('return `${prefix}-${Date.now()}-${index + 1}${extensionForMimeType(file?.type)}`;');
  });

  it('passes that filename to FormData so server-side pending files are usable', () => {
    expect(chatInputSource).toContain("formData.append('files', attachment.file, attachment.uploadName);");
    expect(chatInputSource).not.toContain("formData.append('files', file);");
  });

  it('maps upload results only to the files in the current paste batch', () => {
    expect(chatInputSource).toContain('const pendingAttachments = [];');
    expect(chatInputSource).toContain('pendingAttachments.push(attachment);');
    expect(chatInputSource).toContain('for (const attachment of pendingAttachments)');
    expect(chatInputSource).not.toContain('for (const attachment of attachments.value) {\n          if (attachment.uploading && !attachment.fileId)');
  });
});
