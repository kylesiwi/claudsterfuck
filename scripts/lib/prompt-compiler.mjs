/**
 * Prompt Compiler - Always-on Lite compression for worker handoff
 *
 * Pipeline: compress -> validate -> targeted-fix -> fail-open
 *
 * Immutable sections marked with <!-- IMMUTABLE --> delimiters are preserved byte-for-byte.
 * Only mutable natural-language text between immutable sections gets compressed.
 */

const IMMUTABLE_OPEN = "<!-- IMMUTABLE -->";
const IMMUTABLE_CLOSE = "<!-- /IMMUTABLE -->";
const PLACEHOLDER_PREFIX = "\x00IMMUTABLE_BLOCK_";
const PLACEHOLDER_SUFFIX = "\x00";

// Compression rules (Lite Caveman style)
const FILLER_PATTERNS = [
  [/\b(basically|essentially|actually|just|really|very|quite|simply)\b\s*/gi, ""],
  [/\b(please note that|it's worth noting that|it is worth noting that|keep in mind that|note that)\b\s*/gi, ""],
  [/\b(I think|it seems like|it appears that|perhaps|maybe)\b\s*/gi, ""],
  [/\bin order to\b/gi, "to"],
  [/\bmake sure to\b/gi, "ensure"],
  [/\bat this point in time\b/gi, "now"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bin the event that\b/gi, "if"],
  [/\bwith regard to\b/gi, "regarding"],
  [/\ba large number of\b/gi, "many"],
  [/\bin spite of the fact that\b/gi, "despite"],
  [/\bhas the ability to\b/gi, "can"],
  [/\bit is important to\b/gi, ""],
];

function makePlaceholder(index) {
  return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

function extractImmutableSections(rawPrompt) {
  const immutableBlocks = [];
  let mutableText = rawPrompt;
  let searchStart = 0;

  while (true) {
    const openIdx = mutableText.indexOf(IMMUTABLE_OPEN, searchStart);
    if (openIdx === -1) break;

    const closeIdx = mutableText.indexOf(IMMUTABLE_CLOSE, openIdx + IMMUTABLE_OPEN.length);
    if (closeIdx === -1) break;

    const blockEnd = closeIdx + IMMUTABLE_CLOSE.length;
    const fullBlock = mutableText.slice(openIdx, blockEnd);
    const placeholder = makePlaceholder(immutableBlocks.length);

    immutableBlocks.push(fullBlock);
    mutableText = mutableText.slice(0, openIdx) + placeholder + mutableText.slice(blockEnd);
    searchStart = openIdx + placeholder.length;
  }

  return { mutableText, immutableBlocks };
}

function applyLiteCompression(text) {
  let result = text;

  for (const [pattern, replacement] of FILLER_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  // Collapse multiple blank lines to single blank line
  result = result.replace(/\n{3,}/g, "\n\n");

  // Trim trailing whitespace from lines
  result = result.replace(/[ \t]+$/gm, "");

  return result;
}

function validatePlaceholders(text, immutableBlocks) {
  for (let i = 0; i < immutableBlocks.length; i++) {
    const placeholder = makePlaceholder(i);
    if (!text.includes(placeholder)) {
      return false;
    }
  }
  return true;
}

function attemptTargetedFix(compressed, immutableBlocks, originalMutable) {
  let fixed = compressed;

  for (let i = 0; i < immutableBlocks.length; i++) {
    const placeholder = makePlaceholder(i);
    if (fixed.includes(placeholder)) continue;

    // Find where the placeholder was in the original mutable text
    const originalIdx = originalMutable.indexOf(placeholder);
    if (originalIdx === -1) continue;

    // Find the nearest surviving placeholder or text boundary
    // and insert the missing placeholder at approximately the same relative position
    const ratio = originalIdx / originalMutable.length;
    const insertAt = Math.round(ratio * fixed.length);

    // Find a newline near the insertion point to avoid splitting words
    let bestPos = insertAt;
    for (let delta = 0; delta < 100; delta++) {
      if (insertAt + delta < fixed.length && fixed[insertAt + delta] === "\n") {
        bestPos = insertAt + delta + 1;
        break;
      }
      if (insertAt - delta >= 0 && fixed[insertAt - delta] === "\n") {
        bestPos = insertAt - delta + 1;
        break;
      }
    }

    fixed = fixed.slice(0, bestPos) + placeholder + fixed.slice(bestPos);
  }

  return fixed;
}

function restoreImmutableSections(text, immutableBlocks) {
  let result = text;
  for (let i = 0; i < immutableBlocks.length; i++) {
    const placeholder = makePlaceholder(i);
    result = result.replace(placeholder, immutableBlocks[i]);
  }
  return result;
}

export function compilePrompt(rawPrompt) {
  if (!rawPrompt || typeof rawPrompt !== "string") {
    return {
      prompt: rawPrompt ?? "",
      compressed: false,
      fallback: true,
      reason: "invalid_input",
    };
  }

  const { mutableText, immutableBlocks } = extractImmutableSections(rawPrompt);

  let compressed = applyLiteCompression(mutableText);

  // Validate all placeholders survived
  let valid = validatePlaceholders(compressed, immutableBlocks);

  if (!valid) {
    // Targeted fix: try to reinsert missing placeholders
    compressed = attemptTargetedFix(compressed, immutableBlocks, mutableText);
    const fixedValid = validatePlaceholders(compressed, immutableBlocks);

    if (!fixedValid) {
      // Fail open: return original
      return {
        prompt: rawPrompt,
        compressed: false,
        fallback: true,
        reason: "placeholder_validation_failed",
      };
    }
  }

  const finalPrompt = restoreImmutableSections(compressed, immutableBlocks);

  return {
    prompt: finalPrompt,
    compressed: true,
    fallback: false,
    originalLength: rawPrompt.length,
    compressedLength: finalPrompt.length,
    reduction: Math.round((1 - finalPrompt.length / rawPrompt.length) * 100),
  };
}
