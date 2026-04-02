import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for task-218: Crew Route Notification + Feature Panel Route aggregation.
 *
 * Subtask A: CrewNotifications toast component + crew_routing WS handler
 * Subtask B: Feature Panel Route Activity area (global aggregation)
 * Subtask C: Per-feature route pipeline in feature cards
 */

const base = resolve(__dirname, '../..');
const read = (rel) => readFileSync(resolve(base, rel), 'utf-8');

let crewSource;
let chatStoreSource;
let notifSource;
let notifCssSource;
let chatViewSource;
let featurePanelSource;
let workspaceCssSource;
let crewCssSource;

beforeAll(() => {
  crewSource = read('web/stores/helpers/crew.js');
  chatStoreSource = read('web/stores/chat.js');
  notifSource = read('web/components/crew/CrewNotifications.js');
  notifCssSource = read('web/styles/crew-notifications.css');
  chatViewSource = read('web/components/CrewChatView.js');
  featurePanelSource = read('web/components/crew/CrewFeaturePanel.js');
  workspaceCssSource = read('web/styles/crew-workspace.css');
  crewCssSource = read('web/styles/crew.css');
});

// =============================================================================
// SUBTASK A: CrewNotifications toast component
// =============================================================================
describe('Subtask A: CrewNotifications component', () => {
  it('component file exists and has correct name', () => {
    expect(notifSource).toContain("name: 'CrewNotifications'");
  });

  it('accepts notifications prop as Array', () => {
    expect(notifSource).toContain('notifications: { type: Array');
  });

  it('emits dismiss event', () => {
    expect(notifSource).toContain("emits: ['dismiss']");
  });

  it('uses transition-group with crew-notif name for animations', () => {
    expect(notifSource).toContain('<transition-group name="crew-notif"');
    expect(notifSource).toContain('tag="div"');
    expect(notifSource).toContain('class="crew-notifications"');
  });

  it('renders fromIcon, fromName, arrow, toIcon, toName for each notification', () => {
    expect(notifSource).toContain('n.fromIcon');
    expect(notifSource).toContain('n.fromName');
    expect(notifSource).toContain('crew-notif-arrow');
    expect(notifSource).toContain('n.toIcon');
    expect(notifSource).toContain('n.toName');
  });

  it('uses shortName from crewHelpers for name display', () => {
    expect(notifSource).toContain("import { shortName } from './crewHelpers.js'");
    expect(notifSource).toContain('short(n.fromName)');
    expect(notifSource).toContain('short(n.toName)');
  });

  it('shows optional taskTitle', () => {
    expect(notifSource).toContain('v-if="n.taskTitle"');
    expect(notifSource).toContain('n.taskTitle');
  });

  it('click on toast emits dismiss with notification id', () => {
    expect(notifSource).toContain("@click=\"$emit('dismiss', n.id)\"");
  });

  it('auto-dismisses after 4 seconds via watcher', () => {
    expect(notifSource).toContain('setTimeout');
    expect(notifSource).toContain('4000');
    expect(notifSource).toContain("this.$emit('dismiss', n.id)");
  });

  it('tracks _timerSet to avoid duplicate timers', () => {
    expect(notifSource).toContain('n._timerSet');
    expect(notifSource).toContain('_timerSet = true');
  });

  it('watcher is deep and immediate', () => {
    expect(notifSource).toContain('deep: true');
    expect(notifSource).toContain('immediate: true');
  });

  it('uses :key="n.id" for v-for loop', () => {
    expect(notifSource).toContain(':key="n.id"');
  });
});

// =============================================================================
// SUBTASK A: crew-notifications.css
// =============================================================================
describe('Subtask A: crew-notifications.css', () => {
  it('positions notifications fixed at top-right', () => {
    expect(notifCssSource).toContain('position: fixed');
    expect(notifCssSource).toContain('top: 12px');
    expect(notifCssSource).toContain('right: 16px');
  });

  it('has high z-index for overlay visibility', () => {
    expect(notifCssSource).toContain('z-index: 1100');
  });

  it('stacks toasts vertically with gap', () => {
    expect(notifCssSource).toContain('flex-direction: column');
    expect(notifCssSource).toContain('gap: 6px');
  });

  it('container is pointer-events: none but toasts are pointer-events: auto', () => {
    // Container: pointer-events: none (so clicks pass through to page)
    expect(notifCssSource).toMatch(/\.crew-notifications\s*\{[\s\S]*?pointer-events:\s*none/);
    // Toast: pointer-events: auto (so individual toasts are clickable)
    expect(notifCssSource).toMatch(/\.crew-notif-toast\s*\{[\s\S]*?pointer-events:\s*auto/);
  });

  it('toast is clickable with cursor: pointer', () => {
    expect(notifCssSource).toMatch(/\.crew-notif-toast[\s\S]*?cursor:\s*pointer/);
  });

  it('has slide-in-from-right animation', () => {
    expect(notifCssSource).toContain('crewNotifIn');
    expect(notifCssSource).toContain('translateX(30px)');
    expect(notifCssSource).toContain('translateX(0)');
  });

  it('has enter and leave transition classes', () => {
    expect(notifCssSource).toContain('.crew-notif-enter-active');
    expect(notifCssSource).toContain('.crew-notif-leave-active');
  });

  it('has move transition for stack reordering', () => {
    expect(notifCssSource).toContain('.crew-notif-move');
    expect(notifCssSource).toContain('transition: transform');
  });

  it('uses CSS variables for theming (works in dark mode)', () => {
    expect(notifCssSource).toContain('var(--text-primary)');
    expect(notifCssSource).toContain('var(--bg-sidebar)');
    expect(notifCssSource).toContain('var(--border-color)');
    expect(notifCssSource).toContain('var(--text-muted)');
  });

  it('task title has text overflow ellipsis', () => {
    expect(notifCssSource).toMatch(/\.crew-notif-task[\s\S]*?text-overflow:\s*ellipsis/);
  });
});

// =============================================================================
// SUBTASK A: crew.css imports crew-notifications.css
// =============================================================================
describe('Subtask A: crew.css imports notification styles', () => {
  it('crew.css imports crew-notifications.css', () => {
    expect(crewCssSource).toContain("@import url('./crew-notifications.css')");
  });
});

// =============================================================================
// SUBTASK A: crew_routing handler in crew.js
// =============================================================================
describe('Subtask A: crew_routing WS handler in crew.js', () => {
  it('handles crew_routing message type', () => {
    expect(crewSource).toContain("if (msg.type === 'crew_routing')");
  });

  it('only processes routing status with non-empty routes', () => {
    const handlerIdx = crewSource.indexOf("if (msg.type === 'crew_routing')");
    const handlerBlock = crewSource.substring(handlerIdx, crewSource.indexOf('return;', handlerIdx) + 7);
    expect(handlerBlock).toContain("msg.status === 'routing'");
    expect(handlerBlock).toContain('msg.routes && msg.routes.length > 0');
  });

  it('looks up role display names from session roles', () => {
    const handlerIdx = crewSource.indexOf("if (msg.type === 'crew_routing')");
    const handlerBlock = crewSource.substring(handlerIdx, crewSource.indexOf('return;', handlerIdx) + 7);
    expect(handlerBlock).toContain("store.crewSessions[sid]?.roles || []");
    expect(handlerBlock).toContain('sessionRoles.find(r => r.name === msg.fromRole)');
    expect(handlerBlock).toContain('sessionRoles.find(r => r.name === route.to)');
  });

  it('creates notification with all required fields', () => {
    const handlerIdx = crewSource.indexOf("if (msg.type === 'crew_routing')");
    const handlerBlock = crewSource.substring(handlerIdx, crewSource.indexOf('return;', handlerIdx) + 7);
    // Verify all required fields
    expect(handlerBlock).toContain('id: Date.now() + Math.random()');
    expect(handlerBlock).toContain('fromRole: msg.fromRole');
    expect(handlerBlock).toContain('fromIcon:');
    expect(handlerBlock).toContain('fromName:');
    expect(handlerBlock).toContain('toRole: route.to');
    expect(handlerBlock).toContain('toIcon:');
    expect(handlerBlock).toContain('toName:');
    expect(handlerBlock).toContain('taskId:');
    expect(handlerBlock).toContain('taskTitle:');
    expect(handlerBlock).toContain('timestamp: Date.now()');
  });

  it('pushes to store.crewNotifications', () => {
    const handlerIdx = crewSource.indexOf("if (msg.type === 'crew_routing')");
    const handlerBlock = crewSource.substring(handlerIdx, crewSource.indexOf('return;', handlerIdx) + 7);
    expect(handlerBlock).toContain('store.crewNotifications.push(');
  });

  it('iterates over msg.routes for multiple route targets', () => {
    const handlerIdx = crewSource.indexOf("if (msg.type === 'crew_routing')");
    const handlerBlock = crewSource.substring(handlerIdx, crewSource.indexOf('return;', handlerIdx) + 7);
    expect(handlerBlock).toContain('for (const route of msg.routes)');
  });

  it('falls back to role name when displayName is missing', () => {
    const handlerIdx = crewSource.indexOf("if (msg.type === 'crew_routing')");
    const handlerBlock = crewSource.substring(handlerIdx, crewSource.indexOf('return;', handlerIdx) + 7);
    expect(handlerBlock).toContain("fromRoleObj?.displayName || msg.fromRole");
    expect(handlerBlock).toContain("toRoleObj?.displayName || route.to");
  });
});

// =============================================================================
// SUBTASK A: crew_session_cleared clears notifications
// =============================================================================
describe('Subtask A: crew_session_cleared clears notifications', () => {
  it('clears crewNotifications on session cleared', () => {
    const clearedIdx = crewSource.indexOf("msg.type === 'crew_session_cleared'");
    expect(clearedIdx).toBeGreaterThan(-1);
    const clearedBlock = crewSource.substring(clearedIdx, crewSource.indexOf('return;', clearedIdx + 100) + 7);
    expect(clearedBlock).toContain('store.crewNotifications = []');
  });
});

// =============================================================================
// SUBTASK A: chat.js state includes crewNotifications
// =============================================================================
describe('Subtask A: chat.js state', () => {
  it('declares crewNotifications as empty array in store state', () => {
    expect(chatStoreSource).toContain('crewNotifications: []');
  });
});

// =============================================================================
// SUBTASK A: CrewChatView mounts CrewNotifications
// =============================================================================
describe('Subtask A: CrewChatView integration', () => {
  it('imports CrewNotifications component', () => {
    expect(chatViewSource).toContain("import CrewNotifications from './crew/CrewNotifications.js'");
  });

  it('registers CrewNotifications in components', () => {
    expect(chatViewSource).toContain('CrewNotifications');
    const componentsMatch = chatViewSource.match(/components:\s*\{([^}]+)\}/);
    expect(componentsMatch[1]).toContain('CrewNotifications');
  });

  it('passes store.crewNotifications to component', () => {
    expect(chatViewSource).toContain(':notifications="store.crewNotifications"');
  });

  it('handles dismiss event', () => {
    expect(chatViewSource).toContain('@dismiss="dismissNotification"');
  });

  it('dismissNotification removes notification by id from store', () => {
    expect(chatViewSource).toContain('dismissNotification(id)');
    expect(chatViewSource).toContain('store.crewNotifications.findIndex');
    expect(chatViewSource).toContain('store.crewNotifications.splice(idx, 1)');
  });

  it('notification component is placed outside crew-workspace (overlay positioning)', () => {
    // crew-notifications should be after the </div><!-- /crew-workspace --> but still inside the component
    const workspaceEnd = chatViewSource.indexOf('</div><!-- /crew-workspace -->');
    const notifMount = chatViewSource.indexOf('<crew-notifications');
    expect(workspaceEnd).toBeGreaterThan(-1);
    expect(notifMount).toBeGreaterThan(workspaceEnd);
  });
});

// =============================================================================
// SUBTASK B: Feature Panel Route Activity area
// =============================================================================
describe('Subtask B: Feature Panel Route Activity', () => {
  it('accepts crewMessages prop', () => {
    expect(featurePanelSource).toContain("crewMessages: { type: Array");
  });

  it('has recentRoutes computed property filtering type=route', () => {
    expect(featurePanelSource).toContain('recentRoutes()');
    expect(featurePanelSource).toContain("m.type === 'route'");
  });

  it('recentRoutes limits to 20 entries', () => {
    // The loop condition checks routes.length < 20
    expect(featurePanelSource).toContain('routes.length < 20');
  });

  it('recentRoutes iterates backward (newest first)', () => {
    const recentRoutesIdx = featurePanelSource.indexOf('recentRoutes()');
    const recentRoutesBlock = featurePanelSource.substring(
      recentRoutesIdx,
      featurePanelSource.indexOf('}', featurePanelSource.indexOf('return routes;', recentRoutesIdx)) + 1
    );
    expect(recentRoutesBlock).toContain('this.crewMessages.length - 1');
    expect(recentRoutesBlock).toContain('i >= 0');
  });

  it('shows Route Activity section when routes exist', () => {
    expect(featurePanelSource).toContain('v-if="recentRoutes.length > 0"');
    expect(featurePanelSource).toContain('crew-route-activity');
  });

  it('Route Activity header is clickable to toggle', () => {
    expect(featurePanelSource).toContain('showRouteActivity = !showRouteActivity');
  });

  it('has showRouteActivity data property defaulting to true', () => {
    expect(featurePanelSource).toContain('showRouteActivity: true');
  });

  it('shows chevron with rotation class for expand state', () => {
    expect(featurePanelSource).toContain('crew-route-activity-chevron');
    expect(featurePanelSource).toContain("'is-expanded': showRouteActivity");
  });

  it('displays count of routes in header', () => {
    expect(featurePanelSource).toContain('recentRoutes.length');
    expect(featurePanelSource).toContain('crew-route-activity-count');
  });

  it('shows route items with from/to/time info and task in group header', () => {
    expect(featurePanelSource).toContain('crew-route-activity-from');
    expect(featurePanelSource).toContain('crew-route-activity-arrow');
    expect(featurePanelSource).toContain('crew-route-activity-to');
    // Task info is in group header, not per-item
    expect(featurePanelSource).toContain('crew-route-task-group-title');
    expect(featurePanelSource).toContain('crew-route-activity-time');
  });

  it('uses shortNameFn for from name display', () => {
    expect(featurePanelSource).toContain('shortNameFn(r.roleName)');
  });

  it('uses formatTime for timestamp display', () => {
    expect(featurePanelSource).toContain('formatTime(r.timestamp)');
  });

  it('imports shortName from crewHelpers', () => {
    expect(featurePanelSource).toContain('shortName');
    expect(featurePanelSource).toMatch(/import\s*\{[^}]*shortName[^}]*\}\s*from\s*'\.\/crewHelpers\.js'/);
  });

  it('maps shortName to shortNameFn method', () => {
    expect(featurePanelSource).toContain('shortNameFn: shortName');
  });

  it('Route Activity appears in list mode (v-else section)', () => {
    // Should be inside the template v-else section (list mode)
    const templateMatch = featurePanelSource.match(/template:\s*`([\s\S]*?)`\s*,/);
    const listSection = templateMatch[1].split('v-else>')[1];
    expect(listSection).toContain('crew-route-activity');
  });

  it('Route Activity appears before feature cards', () => {
    const templateMatch = featurePanelSource.match(/template:\s*`([\s\S]*?)`\s*,/);
    const listSection = templateMatch[1].split('v-else>')[1];
    const routeActivityIdx = listSection.indexOf('crew-route-activity');
    const kanbanGroupIdx = listSection.indexOf('crew-kanban-group');
    expect(routeActivityIdx).toBeLessThan(kanbanGroupIdx);
  });
});

// =============================================================================
// SUBTASK B: Route Activity CSS
// =============================================================================
describe('Subtask B: Route Activity CSS', () => {
  it('crew-route-activity has bottom border separator', () => {
    expect(workspaceCssSource).toContain('.crew-route-activity');
    expect(workspaceCssSource).toMatch(/\.crew-route-activity\s*\{[\s\S]*?border-bottom/);
  });

  it('chevron rotates 90deg when expanded', () => {
    expect(workspaceCssSource).toContain('.crew-route-activity-chevron.is-expanded');
    expect(workspaceCssSource).toContain('rotate(90deg)');
  });

  it('route activity items are flex-aligned', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-activity-item\s*\{[\s\S]*?display:\s*flex/);
  });

  it('time is pushed to the right with margin-left: auto', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-activity-time\s*\{[\s\S]*?margin-left:\s*auto/);
  });
});

// =============================================================================
// SUBTASK C: Per-feature route pipeline in feature cards
// =============================================================================
describe('Subtask C: Feature Card route pipeline', () => {
  it('getFeatureRoutes method exists and filters by taskId', () => {
    expect(featurePanelSource).toContain('getFeatureRoutes(taskId)');
    const methodIdx = featurePanelSource.indexOf('getFeatureRoutes(taskId)');
    const methodBlock = featurePanelSource.substring(
      methodIdx,
      featurePanelSource.indexOf('}', featurePanelSource.indexOf('return routes;', methodIdx)) + 1
    );
    expect(methodBlock).toContain("m.type === 'route' && m.taskId === taskId");
  });

  it('getFeatureRoutes limits to 3 entries', () => {
    const methodIdx = featurePanelSource.indexOf('getFeatureRoutes(taskId)');
    const methodBlock = featurePanelSource.substring(
      methodIdx,
      featurePanelSource.indexOf('}', featurePanelSource.indexOf('return routes;', methodIdx)) + 1
    );
    expect(methodBlock).toContain('routes.length < 3');
  });

  it('getFeatureRoutes maintains chronological order (unshift)', () => {
    const methodIdx = featurePanelSource.indexOf('getFeatureRoutes(taskId)');
    const methodBlock = featurePanelSource.substring(
      methodIdx,
      featurePanelSource.indexOf('}', featurePanelSource.indexOf('return routes;', methodIdx)) + 1
    );
    expect(methodBlock).toContain('routes.unshift(m)');
  });

  it('renders route pipeline only when routes exist', () => {
    expect(featurePanelSource).toContain('v-if="getFeatureRoutes(feature.taskId).length > 0"');
    expect(featurePanelSource).toContain('crew-feature-route-pipeline');
  });

  it('renders pipeline steps with icon and name', () => {
    expect(featurePanelSource).toContain('crew-route-step');
    expect(featurePanelSource).toContain('crew-route-step-icon');
    expect(featurePanelSource).toContain('crew-route-step-name');
  });

  it('renders arrows between steps', () => {
    expect(featurePanelSource).toContain('crew-route-step-arrow');
  });

  it('adds final arrow and last destination step from last route', () => {
    // After the v-for loop, there should be a final arrow and last routeTo
    expect(featurePanelSource).toContain("getFeatureRoutes(feature.taskId).slice(-1)[0]?.routeTo");
  });

  it('route pipeline appears in both in-progress and completed feature cards', () => {
    // Count occurrences of crew-feature-route-pipeline in template
    const matches = featurePanelSource.match(/crew-feature-route-pipeline/g);
    // Should appear at least twice (once for in-progress cards, once for completed cards)
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('uses shortNameFn for route step names', () => {
    expect(featurePanelSource).toContain('shortNameFn(r.roleName)');
  });
});

// =============================================================================
// SUBTASK C: Per-feature route pipeline CSS
// =============================================================================
describe('Subtask C: Route pipeline CSS', () => {
  it('pipeline uses flex layout', () => {
    expect(workspaceCssSource).toMatch(/\.crew-feature-route-pipeline\s*\{[\s\S]*?display:\s*flex/);
  });

  it('pipeline supports wrapping', () => {
    expect(workspaceCssSource).toMatch(/\.crew-feature-route-pipeline\s*\{[\s\S]*?flex-wrap:\s*wrap/);
  });

  it('route step uses compact font size', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-step\s*\{[\s\S]*?font-size:\s*10px/);
  });

  it('route step arrow has even smaller font', () => {
    expect(workspaceCssSource).toMatch(/\.crew-route-step-arrow\s*\{[\s\S]*?font-size:\s*9px/);
  });
});

// =============================================================================
// SUBTASK A: CrewChatView passes crewMessages to FeaturePanel
// =============================================================================
describe('Subtask A/B: CrewChatView passes crewMessages to FeaturePanel', () => {
  it('passes :crew-messages to CrewFeaturePanel', () => {
    expect(chatViewSource).toContain(':crew-messages="paneCrewMessages"');
  });
});

// =============================================================================
// Functional test: crew_routing handler logic
// =============================================================================
describe('Functional: crew_routing notification creation', () => {
  it('creates correct notification for single route', () => {
    const store = {
      crewSessions: {
        's1': {
          roles: [
            { name: 'pm', displayName: 'PM-Jobs', icon: '📋' },
            { name: 'dev-1', displayName: 'Dev-Torvalds', icon: '💻' }
          ]
        }
      },
      crewNotifications: []
    };

    const msg = {
      type: 'crew_routing',
      sessionId: 's1',
      fromRole: 'pm',
      routes: [{ to: 'dev-1', taskId: 'task-100', taskTitle: 'Build feature' }],
      status: 'routing'
    };

    // Simulate handler logic
    const sid = msg.sessionId;
    if (msg.status === 'routing' && msg.routes && msg.routes.length > 0) {
      const sessionRoles = store.crewSessions[sid]?.roles || [];
      const fromRoleObj = sessionRoles.find(r => r.name === msg.fromRole);
      for (const route of msg.routes) {
        const toRoleObj = sessionRoles.find(r => r.name === route.to);
        store.crewNotifications.push({
          id: 1,
          fromRole: msg.fromRole,
          fromIcon: fromRoleObj?.icon || '',
          fromName: fromRoleObj?.displayName || msg.fromRole,
          toRole: route.to,
          toIcon: toRoleObj?.icon || '',
          toName: toRoleObj?.displayName || route.to,
          taskId: route.taskId || null,
          taskTitle: route.taskTitle || null,
          timestamp: Date.now()
        });
      }
    }

    expect(store.crewNotifications).toHaveLength(1);
    const n = store.crewNotifications[0];
    expect(n.fromRole).toBe('pm');
    expect(n.fromIcon).toBe('📋');
    expect(n.fromName).toBe('PM-Jobs');
    expect(n.toRole).toBe('dev-1');
    expect(n.toIcon).toBe('💻');
    expect(n.toName).toBe('Dev-Torvalds');
    expect(n.taskId).toBe('task-100');
    expect(n.taskTitle).toBe('Build feature');
  });

  it('creates multiple notifications for multi-route message', () => {
    const store = {
      crewSessions: {
        's1': {
          roles: [
            { name: 'pm', displayName: 'PM', icon: '📋' },
            { name: 'dev-1', displayName: 'Dev1', icon: '💻' },
            { name: 'rev-1', displayName: 'Rev1', icon: '🔍' }
          ]
        }
      },
      crewNotifications: []
    };

    const msg = {
      type: 'crew_routing',
      sessionId: 's1',
      fromRole: 'pm',
      routes: [
        { to: 'dev-1', taskId: 'task-1' },
        { to: 'rev-1', taskId: 'task-1' }
      ],
      status: 'routing'
    };

    const sid = msg.sessionId;
    const sessionRoles = store.crewSessions[sid]?.roles || [];
    const fromRoleObj = sessionRoles.find(r => r.name === msg.fromRole);
    for (const route of msg.routes) {
      const toRoleObj = sessionRoles.find(r => r.name === route.to);
      store.crewNotifications.push({
        id: Date.now() + Math.random(),
        fromRole: msg.fromRole,
        fromIcon: fromRoleObj?.icon || '',
        fromName: fromRoleObj?.displayName || msg.fromRole,
        toRole: route.to,
        toIcon: toRoleObj?.icon || '',
        toName: toRoleObj?.displayName || route.to,
        taskId: route.taskId || null,
        taskTitle: route.taskTitle || null,
        timestamp: Date.now()
      });
    }

    expect(store.crewNotifications).toHaveLength(2);
    expect(store.crewNotifications[0].toRole).toBe('dev-1');
    expect(store.crewNotifications[1].toRole).toBe('rev-1');
  });

  it('ignores crew_routing with status=done (no notifications created)', () => {
    const store = { crewNotifications: [] };
    const msg = {
      type: 'crew_routing',
      sessionId: 's1',
      fromRole: 'pm',
      status: 'done'
    };

    // Handler checks status === 'routing' — done status should not add notifications
    if (msg.status === 'routing' && msg.routes && msg.routes.length > 0) {
      store.crewNotifications.push({ id: 1 });
    }
    expect(store.crewNotifications).toHaveLength(0);
  });

  it('falls back to role name when session roles are empty', () => {
    const store = {
      crewSessions: { 's1': { roles: [] } },
      crewNotifications: []
    };

    const msg = {
      type: 'crew_routing',
      sessionId: 's1',
      fromRole: 'pm',
      routes: [{ to: 'dev-1', taskId: 'task-1' }],
      status: 'routing'
    };

    const sid = msg.sessionId;
    const sessionRoles = store.crewSessions[sid]?.roles || [];
    const fromRoleObj = sessionRoles.find(r => r.name === msg.fromRole);
    for (const route of msg.routes) {
      const toRoleObj = sessionRoles.find(r => r.name === route.to);
      store.crewNotifications.push({
        id: 1,
        fromRole: msg.fromRole,
        fromIcon: fromRoleObj?.icon || '',
        fromName: fromRoleObj?.displayName || msg.fromRole,
        toRole: route.to,
        toIcon: toRoleObj?.icon || '',
        toName: toRoleObj?.displayName || route.to,
        taskId: route.taskId || null,
        taskTitle: route.taskTitle || null,
        timestamp: Date.now()
      });
    }

    expect(store.crewNotifications).toHaveLength(1);
    expect(store.crewNotifications[0].fromName).toBe('pm');
    expect(store.crewNotifications[0].toName).toBe('dev-1');
    expect(store.crewNotifications[0].fromIcon).toBe('');
    expect(store.crewNotifications[0].toIcon).toBe('');
  });
});

// =============================================================================
// Functional test: getFeatureRoutes logic
// =============================================================================
describe('Functional: getFeatureRoutes filtering', () => {
  function getFeatureRoutes(crewMessages, taskId) {
    const routes = [];
    for (let i = crewMessages.length - 1; i >= 0 && routes.length < 3; i--) {
      const m = crewMessages[i];
      if (m.type === 'route' && m.taskId === taskId) {
        routes.unshift(m);
      }
    }
    return routes;
  }

  it('returns empty array when no route messages exist', () => {
    const messages = [
      { type: 'text', taskId: 'task-1', role: 'pm' }
    ];
    expect(getFeatureRoutes(messages, 'task-1')).toEqual([]);
  });

  it('returns only route messages for the given taskId', () => {
    const messages = [
      { type: 'route', taskId: 'task-1', roleName: 'PM' },
      { type: 'route', taskId: 'task-2', roleName: 'PM' },
      { type: 'route', taskId: 'task-1', roleName: 'Dev' }
    ];
    const result = getFeatureRoutes(messages, 'task-1');
    expect(result).toHaveLength(2);
    expect(result[0].roleName).toBe('PM');
    expect(result[1].roleName).toBe('Dev');
  });

  it('limits to 3 results', () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ type: 'route', taskId: 'task-1', roleName: `Role-${i}` });
    }
    const result = getFeatureRoutes(messages, 'task-1');
    expect(result).toHaveLength(3);
    // Should be the last 3 (indices 7, 8, 9)
    expect(result[0].roleName).toBe('Role-7');
    expect(result[1].roleName).toBe('Role-8');
    expect(result[2].roleName).toBe('Role-9');
  });

  it('maintains chronological order', () => {
    const messages = [
      { type: 'route', taskId: 'task-1', roleName: 'First', timestamp: 100 },
      { type: 'text', taskId: 'task-1' },
      { type: 'route', taskId: 'task-1', roleName: 'Second', timestamp: 200 },
      { type: 'route', taskId: 'task-1', roleName: 'Third', timestamp: 300 }
    ];
    const result = getFeatureRoutes(messages, 'task-1');
    expect(result[0].roleName).toBe('First');
    expect(result[1].roleName).toBe('Second');
    expect(result[2].roleName).toBe('Third');
  });
});

// =============================================================================
// Functional test: recentRoutes logic
// =============================================================================
describe('Functional: recentRoutes filtering', () => {
  function recentRoutes(crewMessages) {
    const routes = [];
    for (let i = crewMessages.length - 1; i >= 0 && routes.length < 8; i--) {
      const m = crewMessages[i];
      if (m.type === 'route') {
        routes.push(m);
      }
    }
    return routes;
  }

  it('returns empty array when no routes', () => {
    expect(recentRoutes([])).toEqual([]);
    expect(recentRoutes([{ type: 'text' }])).toEqual([]);
  });

  it('returns up to 8 most recent route messages', () => {
    const messages = [];
    for (let i = 0; i < 15; i++) {
      messages.push({ type: 'route', id: i });
    }
    const result = recentRoutes(messages);
    expect(result).toHaveLength(8);
    // Most recent first (reversed iteration)
    expect(result[0].id).toBe(14);
    expect(result[7].id).toBe(7);
  });

  it('filters out non-route messages', () => {
    const messages = [
      { type: 'route', id: 1 },
      { type: 'text', id: 2 },
      { type: 'tool_use', id: 3 },
      { type: 'route', id: 4 }
    ];
    const result = recentRoutes(messages);
    expect(result).toHaveLength(2);
  });
});

// =============================================================================
// Functional test: dismissNotification logic
// =============================================================================
describe('Functional: dismissNotification', () => {
  it('removes notification by id', () => {
    const notifications = [
      { id: 1, fromName: 'A' },
      { id: 2, fromName: 'B' },
      { id: 3, fromName: 'C' }
    ];

    const id = 2;
    const idx = notifications.findIndex(n => n.id === id);
    if (idx !== -1) notifications.splice(idx, 1);

    expect(notifications).toHaveLength(2);
    expect(notifications[0].id).toBe(1);
    expect(notifications[1].id).toBe(3);
  });

  it('does nothing when id not found', () => {
    const notifications = [{ id: 1 }, { id: 2 }];
    const id = 99;
    const idx = notifications.findIndex(n => n.id === id);
    if (idx !== -1) notifications.splice(idx, 1);
    expect(notifications).toHaveLength(2);
  });
});
