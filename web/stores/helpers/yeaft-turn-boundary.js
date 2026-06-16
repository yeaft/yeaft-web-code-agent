/**
 * Boundary rules for Yeaft VP turn rendering.
 *
 * A single user turn may fan out to several VPs. Persisted history can reuse
 * the same user-level turnId across those VP replies, so VP owner identity is
 * the hard boundary whenever both sides are explicitly stamped.
 */

function cleanId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function messageVpOwner(msg) {
  return cleanId(msg?.speakerVpId) || cleanId(msg?.vpId);
}

export function shouldCloseYeaftVpTurn(currentTurn, msg) {
  if (!currentTurn || !msg) return false;

  const curSpeaker = cleanId(currentTurn.speakerVpId);
  const msgSpeaker = messageVpOwner(msg);
  if (curSpeaker && msgSpeaker && curSpeaker !== msgSpeaker) return true;

  const curTurnId = cleanId(currentTurn.turnId);
  const msgTurnId = cleanId(msg.turnId);
  if (curTurnId && msgTurnId && curTurnId !== msgTurnId) return true;

  return false;
}
