/**
 * generateImageTool — a tool contract for real image generation.
 *
 * WHY a function tool instead of an AgentTool subagent:
 *   AgentTool converts all subagent output to a text function-response before
 *   returning it to the orchestrator. Binary inlineData (the base64 image bytes
 *   from an image-generation model) is therefore lost in transit.
 *
 *   A function tool runs arbitrary TypeScript: we call @google/genai directly,
 *   receive the raw response including inlineData, write the file to disk, and
 *   return a plain-text confirmation with the saved file path. The orchestrator
 *   sees the path and relays it to the user.
 *
 * The contract is an own Tool (lib/tools/tool.ts); `generateImageTool` is the
 * own Tool the registry lists, made from it by asTool.
 */

import { GoogleGenAI } from '@google/genai';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import { asTool, defineTool } from './toolContract.ts';

const IMAGE_MODEL = 'gemini-3.1-flash-image-preview';

export const generateImageContract = defineTool({
  name: 'generate_image',
  description:
    'Generates a real image from a structured payload and saves it to the outputs/ directory. ' +
    'Returns the saved file path. Call this only after the user has approved the image payload.',
  schema: z.object({
    prompt: z.string().describe('The full image prompt describing the scene and subject.'),
    style: z.string().optional().describe('Visual style (e.g. "Ansel Adams", "impressionist", "photorealistic").'),
    aspect_ratio: z.string().optional().describe('Desired aspect ratio (e.g. "3:2", "16:9", "1:1").'),
    color_palette: z.string().optional().describe('Color palette guidance (e.g. "monochromatic", "warm tones", "vivid").'),
  }),
  execute: async ({ prompt, style, aspect_ratio, color_palette }): Promise<string> => {
    console.log("[ImageTool] Starting image generation execution...");

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) {
      const err = new Error('Gemini API Key is not configured (neither GEMINI_API_KEY nor GOOGLE_GENAI_API_KEY was found in environment).');
      console.error(`[ImageTool ERROR] Initialization failed: ${err.message}`);
      throw err;
    }

    console.log(`[ImageTool] Parameters - Prompt: "${prompt}", Style: "${style ?? 'none'}", Aspect Ratio: "${aspect_ratio ?? 'none'}", Color Palette: "${color_palette ?? 'none'}"`);

    const ai = new GoogleGenAI({ apiKey });

    // Build a rich prompt that bakes in the structured parameters.
    const parts: string[] = [prompt];
    if (style) parts.push(`Style: ${style}`);
    if (color_palette) parts.push(`Color palette: ${color_palette}`);
    if (aspect_ratio) parts.push(`Aspect ratio: ${aspect_ratio}`);
    const fullPrompt = parts.join('. ');

    try {
      console.log(`[ImageTool] Sending generateContent request to Gemini API (Model: ${IMAGE_MODEL})...`);
      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        config: {
          responseModalities: ['IMAGE', 'TEXT'] as any,
        },
      });

      console.log("[ImageTool] Received response from Gemini API.");

      const candidates = response.candidates ?? [];
      console.log(`[ImageTool] Candidates found: ${candidates.length}`);

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        console.log(`[ImageTool] Candidate ${i}: FinishReason = ${candidate.finishReason ?? 'none'}`);
        
        const partsList = candidate.content?.parts ?? [];
        console.log(`[ImageTool] Candidate ${i} has ${partsList.length} parts.`);

        for (let j = 0; j < partsList.length; j++) {
          const part = partsList[j];
          const inlineData = (part as any).inlineData;
          console.log(`[ImageTool] Part ${j}: hasText = ${!!(part as any).text}, hasInlineData = ${!!inlineData}`);

          if (inlineData?.data) {
            const { mimeType, data } = inlineData;
            const ext = (mimeType as string)?.split('/')[1] ?? 'png';
            // OUTPUTS_DIR env overrides the cwd default (package consumers).
            const outputDir = process.env.OUTPUTS_DIR
              ? resolve(process.env.OUTPUTS_DIR)
              : join(process.cwd(), 'outputs');
            
            console.log(`[ImageTool] Found inline image data. MimeType: ${mimeType}, Data Length: ${data.length} chars.`);
            console.log(`[ImageTool] Ensuring output directory exists: ${outputDir}`);
            mkdirSync(outputDir, { recursive: true });
            
            const filename = `image_${Date.now()}.${ext}`;
            const filepath = join(outputDir, filename);
            
            console.log(`[ImageTool] Saving image to disk: ${filepath}`);
            writeFileSync(filepath, Buffer.from(data, 'base64'));
            return `[ImageTool Success] Image saved to outputs/${filename}`;
          }
        }
      }

      // Fallback: model returned text only (no image data in response)
      console.warn("[ImageTool WARNING] No image data found in any of the response parts.");
      const textFallback = candidates[0]?.content?.parts
        ?.map((p: any) => p.text)
        .filter(Boolean)
        .join('');
      return textFallback || `No image data returned. Model used: ${IMAGE_MODEL}`;

    } catch (err: unknown) {
      // Surface the raw API error so the orchestrator can relay it accurately.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ImageTool ERROR] Execution failed: ${msg}`);
      return `[generate_image ERROR] Model: ${IMAGE_MODEL} - ${msg}`;
    }
  },
});

/** The own Tool, ready for the registry. */
export const generateImageTool = asTool(generateImageContract);
