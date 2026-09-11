/**
 * workbench.js — re-export entry point.
 * Actual implementations live in workbench/ sub-modules.
 */

export { resolveAndValidatePath, getGitRoot, validateGitPath } from './workbench/utils.js';

export {
  handleReadFile, handleVideoMetadata, handleVideoChunk, handleWriteFile, handleListDirectory,
  handleCreateFile, handleDeleteFiles, handleMoveFiles, handleCopyFiles, handleUploadToDir
} from './workbench/file-ops.js';

export {
  handleGitStatus, handleGitDiff, handleGitAdd, handleGitReset,
  handleGitRestore, handleGitCommit, handleGitPush
} from './workbench/git-ops.js';

export { handleFileSearch } from './workbench/file-search.js';
export { handleResolveFileReferences } from './workbench/file-reference-resolver.js';

export { handleTransferFiles } from './workbench/transfer.js';
