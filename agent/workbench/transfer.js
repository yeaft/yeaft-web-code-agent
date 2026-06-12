import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';
import ctx from '../context.js';
import { getProvider, DEFAULT_PROVIDER } from '../providers/index.js';
import { sendOutput, sendConversationList } from '../conversation.js';

// 临时文件目录名 (不易冲突)
const TEMP_UPLOAD_DIR = '.claude-tmp-attachments';

export async function handleTransferFiles(msg) {
  const { conversationId, files, prompt, workDir, claudeSessionId } = msg;

  let state = ctx.conversations.get(conversationId);
  const effectiveWorkDir = workDir || state?.workDir || ctx.CONFIG.workDir;

  // 创建临时目录
  const uploadDir = join(effectiveWorkDir, TEMP_UPLOAD_DIR);
  if (!existsSync(uploadDir)) {
    mkdirSync(uploadDir, { recursive: true });
  }

  const savedFiles = [];
  const imageFiles = [];

  for (const file of files) {
    try {
      const timestamp = Date.now();
      const ext = extname(file.name);
      const baseName = basename(file.name, ext);
      const uniqueName = `${baseName}_${timestamp}${ext}`;
      const filePath = join(uploadDir, uniqueName);
      const relativePath = join(TEMP_UPLOAD_DIR, uniqueName);

      const buffer = Buffer.from(file.data, 'base64');
      writeFileSync(filePath, buffer);

      const isImage = file.mimeType.startsWith('image/');
      savedFiles.push({
        name: file.name,
        path: relativePath,
        mimeType: file.mimeType,
        isImage
      });

      if (isImage) {
        imageFiles.push({
          mimeType: file.mimeType,
          data: file.data
        });
      }

      console.log(`Saved file: ${relativePath}`);
    } catch (e) {
      console.error(`Error saving file ${file.name}:`, e.message);
    }
  }

  // ★ Non-Claude providers (e.g. Copilot): route attachment sends through the
  //   driver, mirroring conversation.js `handleUserInput`. Before this branch
  //   existed, handleTransferFiles unconditionally spawned the Claude CLI via
  //   startClaudeQuery — so a copilot conversation that sent an attachment was
  //   misrouted to `claude --resume <stale-id>` and returned
  //   error_during_execution instantly ("一发送就挂了"). Copilot accepts inline
  //   image bytes over ACP, so images are handed to the driver as attachments
  //   instead of being inlined as disk paths the way the Claude path does.
  //
  // Note: when state is null here, providerName resolves to DEFAULT_PROVIDER
  // ('claude-code'), so this branch only runs for an already-created
  // non-claude conversation — state is guaranteed non-null inside it.
  const providerName = state?.providerName || DEFAULT_PROVIDER;
  if (providerName !== 'claude-code') {
    const driver = getProvider(providerName);
    if (workDir) state.workDir = workDir;

    // Images go inline as provider attachments ([{type,data,mimeType}] — the
    // shape copilot.sendInput understands). Non-image files can't be inlined,
    // so reference their saved paths in the text and let the provider read
    // them with its own file tools (it runs in effectiveWorkDir).
    const attachments = imageFiles.map(img => ({
      type: 'image',
      data: img.data,
      mimeType: img.mimeType,
    }));
    const nonImageFiles = savedFiles.filter(f => !f.isImage);
    let effectivePrompt = prompt || '';
    if (nonImageFiles.length > 0) {
      const fileListText = nonImageFiles.map(f => `- ${f.path} (${f.mimeType})`).join('\n');
      effectivePrompt = `${effectivePrompt}\n\n用户上传了以下文件（已保存到工作目录）：\n${fileListText}`.trim();
    }

    // Echo the user turn so it persists and renders. We echo the RAW user text
    // (not the path-augmented effectivePrompt) so the DB stores a clean user
    // turn. Dedup against the frontend's optimistic copy is by clientMessageId
    // (the server backfills it onto this echo) — see agent-output.js + dedup.js.
    //
    // Attachment-only send (no text): the server persistence gate drops a
    // user message with empty content (agent-output.js), and copilot mirrors
    // our own prompt back as a dropped user_message_chunk — so this echo is the
    // ONLY source of the user turn. Use a non-empty placeholder so the turn
    // survives a page refresh instead of vanishing. Matches the frontend's
    // own attachment-only placeholder (web/stores/chat.js).
    const echoContent = prompt && prompt.trim() ? prompt : '(attached files)';
    sendOutput(conversationId, { type: 'user', message: { role: 'user', content: echoContent } });
    state.turnActive = true;
    sendConversationList();
    try {
      await driver.sendInput(state, effectivePrompt, { conversationId, raw: msg, attachments });
    } catch (err) {
      sendOutput(conversationId, {
        type: 'result',
        subtype: 'error',
        session_id: state.sessionId || null,
        is_error: true,
        error: `${providerName} error: ${err?.message || err}`,
      });
    } finally {
      state.turnActive = false;
      if (state._abortKillTimer) {
        clearTimeout(state._abortKillTimer);
        state._abortKillTimer = null;
      }
      sendConversationList();
    }
    return;
  }

  // ---- Claude-code path ----
  const { startClaudeQuery } = await import('../claude.js');

  // 如果没有活跃的查询，启动新的
  if (!state || !state.query || !state.inputStream) {
    const resumeSessionId = claudeSessionId || state?.claudeSessionId || null;
    console.log(`[SDK] Starting Claude for ${conversationId} (files), resume: ${resumeSessionId || 'none'}`);
    state = await startClaudeQuery(conversationId, effectiveWorkDir, resumeSessionId);
  }

  // 构造带附件的消息
  const fileListText = savedFiles.map(f =>
    `- ${f.path} (${f.isImage ? '图片' : f.mimeType})`
  ).join('\n');

  const fullPrompt = `用户上传了以下文件：\n${fileListText}\n\n用户说：${prompt}`;

  // 构造 content 数组
  const content = [];

  for (const img of imageFiles) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.data
      }
    });
  }

  content.push({
    type: 'text',
    text: fullPrompt
  });

  // 发送用户消息到输入流
  const userMessage = {
    type: 'user',
    message: { role: 'user', content }
  };

  console.log(`[${conversationId}] Sending with ${savedFiles.length} files, ${imageFiles.length} images`);
  state.turnActive = true;
  state.inputStream.enqueue(userMessage);
}
