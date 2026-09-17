const SUPPORTED_WORK_ITEM_ATTACHMENT_PLATFORMS = new Set(['linux', 'darwin', 'win32']);

/**
 * WorkItem attachment storage has a descriptor-anchored Linux implementation
 * and a checked, exclusive-create implementation for macOS and Windows.
 */
export function supportsWorkItemAttachments(platform = process.platform) {
  return SUPPORTED_WORK_ITEM_ATTACHMENT_PLATFORMS.has(platform);
}

export function assertWorkItemAttachmentPlatform(platform = process.platform) {
  if (!supportsWorkItemAttachments(platform)) {
    throw new Error(`Secure WorkItem attachment storage is unavailable on ${platform || 'this platform'}`);
  }
  return platform;
}
