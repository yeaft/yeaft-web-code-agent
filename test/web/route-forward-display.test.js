import { describe, expect, it } from 'vitest';
import {
  formatRouteForwardHandoffLabel,
  formatRouteForwardHandoffReason,
  formatRouteForwardToolLine,
} from '../../web/utils/route-forward-display.js';

const t = (key, params = {}) => {
  const templates = {
    'unify.handoff.targets': 'Forwarded to {mentions}',
    'unify.handoff.chat': '{mentions}: {text}',
    'unify.handoff.broadcast': 'Forwarded to {mentions} (broadcast)',
    'unify.handoff.broadcastChat': '{mentions}: {text} (broadcast)',
    'unify.handoff.reason': 'reason: {reason}',
  };
  return templates[key].replace(/\{(\w+)\}/g, (_, name) => params[name] || '');
};

describe('RouteForward group display formatting', () => {
  it('renders a successful single-target handoff like a group-chat mention', () => {
    const label = formatRouteForwardHandoffLabel({
      toVpIds: ['linus'],
      text: 'please implement and test this',
      reason: 'PM request',
    }, t);

    expect(label).toBe('@linus: please implement and test this');
  });

  it('renders broadcast/all handoffs as broadcast chat instructions', () => {
    const label = formatRouteForwardHandoffLabel({
      toVpIds: ['steve', 'linus', 'martin'],
      broadcast: true,
      text: 'please weigh in',
    }, t);

    expect(label).toBe('@steve, @linus, @martin: please weigh in (broadcast)');
  });

  it('keeps old fallback text when a successful handoff has no instruction text', () => {
    expect(formatRouteForwardHandoffLabel({ toVpIds: ['linus'] }, t))
      .toBe('Forwarded to @linus');
    expect(formatRouteForwardHandoffLabel({ toVpIds: ['linus'], broadcast: true }, t))
      .toBe('Forwarded to @linus (broadcast)');
  });

  it('keeps the handoff reason as secondary audit text', () => {
    expect(formatRouteForwardHandoffReason({ reason: 'needs code owner review' }, t))
      .toBe('reason: needs code owner review');
    expect(formatRouteForwardHandoffReason({}, t)).toBe('');
  });

  it('formats failed or non-handoff RouteForward tool rows as a readable fallback', () => {
    expect(formatRouteForwardToolLine({ to: 'martin', text: 'review PR #785' }))
      .toBe('Route @martin: review PR #785');
    expect(formatRouteForwardToolLine({ to: 'all', text: 'please weigh in' }))
      .toBe('Route @all: please weigh in');
    expect(formatRouteForwardToolLine({ to: 'linus' }))
      .toBe('Route @linus');
  });
});
