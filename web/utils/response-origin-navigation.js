export const longResponseViewportThreshold = 2;

/**
 * Pick the single long response the reader is currently viewing.
 *
 * @param {object} options
 * @param {Array<{ originMessageId: string, top: number, bottom: number, height?: number }>} options.responses
 * @param {number} options.viewportTop
 * @param {number} options.viewportHeight
 * @param {number} [options.thresholdViewports]
 * @param {number} [options.readingLineRatio]
 * @returns {string}
 */
export function resolveLongResponseOrigin({
  responses,
  viewportTop,
  viewportHeight,
  thresholdViewports = longResponseViewportThreshold,
  readingLineRatio = 0.35,
}) {
  const height = Math.max(0, Number(viewportHeight) || 0);
  if (!height) return '';

  const top = Number(viewportTop) || 0;
  const bottom = top + height;
  const readingLine = top + (height * readingLineRatio);
  const minimumResponseHeight = height * thresholdViewports;
  const candidates = (Array.isArray(responses) ? responses : [])
    .map((response, index) => {
      const responseTop = Number(response?.top) || 0;
      const responseBottom = Number(response?.bottom) || 0;
      const responseHeight = Math.max(
        Number(response?.height) || 0,
        responseBottom - responseTop,
      );
      return {
        originMessageId: String(response?.originMessageId || ''),
        top: responseTop,
        bottom: responseBottom,
        height: responseHeight,
        visibleHeight: Math.max(0, Math.min(responseBottom, bottom) - Math.max(responseTop, top)),
        index,
      };
    })
    .filter(response => (
      response.originMessageId
      && response.height >= minimumResponseHeight
      // The action is for returning after the reader has moved into a long
      // answer. Keep it absent while the answer's opening is still visible.
      && response.top < top
      && response.bottom >= readingLine
      && response.visibleHeight > 0
    ));

  if (!candidates.length) return '';

  const atReadingLine = candidates.find(response => (
    response.top <= readingLine && response.bottom >= readingLine
  ));
  if (atReadingLine) return atReadingLine.originMessageId;

  candidates.sort((a, b) => (
    b.visibleHeight - a.visibleHeight
    || Math.abs(((a.top + a.bottom) / 2) - readingLine)
      - Math.abs(((b.top + b.bottom) / 2) - readingLine)
    || a.index - b.index
  ));
  return candidates[0].originMessageId;
}
