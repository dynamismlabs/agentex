/**
 * Splits a message into chunks that each fit within maxLength.
 *
 * Strategy:
 * 1. If text fits, return [text].
 * 2. Split by paragraph boundaries (\n\n).
 * 3. If a paragraph exceeds maxLength, split at line boundaries (\n).
 * 4. If a single line exceeds maxLength, force-split at maxLength.
 * 5. Code fences (```) that span chunks are closed and re-opened.
 * 6. Never produce empty chunks.
 */
export function chunkMessage(text: string, maxLength: number): string[] {
  if (maxLength <= 0) {
    throw new Error("maxLength must be positive");
  }

  if (text.length === 0) {
    return [""];
  }

  if (text.length <= maxLength) {
    return [text];
  }

  const paragraphs = text.split("\n\n");
  const rawChunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      const candidate =
        current.length === 0 ? paragraph : current + "\n\n" + paragraph;

      if (candidate.length <= maxLength) {
        current = candidate;
      } else {
        if (current.length > 0) {
          rawChunks.push(current);
        }
        current = paragraph;
      }
    } else {
      // Paragraph is too long — split by lines
      if (current.length > 0) {
        rawChunks.push(current);
        current = "";
      }

      const lines = paragraph.split("\n");
      for (const line of lines) {
        if (line.length <= maxLength) {
          const candidate =
            current.length === 0 ? line : current + "\n" + line;

          if (candidate.length <= maxLength) {
            current = candidate;
          } else {
            if (current.length > 0) {
              rawChunks.push(current);
            }
            current = line;
          }
        } else {
          // Single line exceeds maxLength — force split
          if (current.length > 0) {
            rawChunks.push(current);
            current = "";
          }

          let remaining = line;
          while (remaining.length > maxLength) {
            rawChunks.push(remaining.slice(0, maxLength));
            remaining = remaining.slice(maxLength);
          }
          if (remaining.length > 0) {
            current = remaining;
          }
        }
      }
    }
  }

  if (current.length > 0) {
    rawChunks.push(current);
  }

  // Code fence handling: track whether we're inside a code block
  // and close/reopen fences across chunk boundaries.
  return applyCodeFenceFixup(rawChunks);
}

function countFences(text: string): number {
  const matches = text.match(/```/g);
  return matches ? matches.length : 0;
}

function extractFenceHeader(text: string): string {
  // Find the last opening fence line (``` possibly followed by language tag)
  const lines = text.split("\n");
  let lastHeader = "```";
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      lastHeader = trimmed;
    }
  }
  return lastHeader;
}

function applyCodeFenceFixup(chunks: string[]): string[] {
  const result: string[] = [];
  let insideCodeBlock = false;
  let lastFenceHeader = "```";

  for (let i = 0; i < chunks.length; i++) {
    let chunk = chunks[i]!;

    if (insideCodeBlock) {
      chunk = lastFenceHeader + "\n" + chunk;
    }

    const fences = countFences(chunk);
    const openAtEnd = fences % 2 === 1;

    if (openAtEnd) {
      // We end inside a code block — need to close it
      lastFenceHeader = extractFenceHeader(chunk);
      chunk = chunk + "\n```";
      insideCodeBlock = true;
    } else {
      insideCodeBlock = false;
    }

    if (chunk.length > 0) {
      result.push(chunk);
    }
  }

  return result;
}
