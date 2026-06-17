/**
 * image-generation.js — Generate images via external API.
 *
 * Delegates to a configured image generation service (DALL-E, etc.).
 */

import { defineTool } from './types.js';

export default defineTool({
  name: 'ImageGeneration',
  description: {
  en: `Generate an image from a text description.

Uses a configured image generation API to create images.
Requires an image generation API endpoint in config.

Guidelines:
- Provide detailed, specific descriptions for best results
- Specify style, composition, and mood
- Images are saved to the working directory`,
  zh: `根据文字描述生成图片。

使用配置的图片生成 API 创建图片。需要配置中设置图片生成 API 端点。

使用指南：
- 提供详细具体的描述以获得最佳效果
- 指定风格、构图和氛围
- 图片保存到工作目录`
},
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Text description of the image to generate',
      },
      output_path: {
        type: 'string',
        description: 'File path to save the generated image',
      },
      size: {
        type: 'string',
        enum: ['256x256', '512x512', '1024x1024'],
        description: 'Image size (default: "1024x1024")',
      },
    },
    required: ['prompt'],
  },
  isConcurrencySafe: () => true,
  isReadOnly: () => false,
  async execute(input, ctx) {
    const { prompt, output_path, size = '1024x1024' } = input;
    if (!prompt) return JSON.stringify({ error: 'prompt is required' });

    const imageApiUrl = ctx?.config?.imageApiUrl;
    if (!imageApiUrl) {
      return JSON.stringify({
        error: 'No image generation API configured.',
        hint: 'Configure imageApiUrl in ~/.yeaft/config.json',
      });
    }

    try {
      const response = await fetch(imageApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, size }),
        signal: ctx?.signal,
      });

      if (!response.ok) {
        return JSON.stringify({ error: `Image API returned ${response.status}: ${response.statusText}` });
      }

      const data = await response.json();

      // If output_path specified, save the image
      if (output_path && data.url) {
        const { resolve: resolvePath } = await import('path');
        const { writeFile } = await import('fs/promises');

        const imgResponse = await fetch(data.url);
        const buffer = Buffer.from(await imgResponse.arrayBuffer());
        const absPath = resolvePath(ctx?.cwd || process.cwd(), output_path);
        await writeFile(absPath, buffer);

        return JSON.stringify({
          success: true,
          path: absPath,
          size,
          prompt: prompt.slice(0, 100),
        });
      }

      return JSON.stringify({
        success: true,
        url: data.url,
        size,
        prompt: prompt.slice(0, 100),
      });
    } catch (err) {
      if (err.name === 'AbortError') return JSON.stringify({ error: 'Generation cancelled' });
      return JSON.stringify({ error: `Image generation failed: ${err.message}` });
    }
  },
});
